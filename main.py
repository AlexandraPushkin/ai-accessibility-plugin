from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import ollama
import json
import logging
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ki-plugin")

app = FastAPI(title="KI-Plugin Backend (generisch, Site-unabhängig)")

ALLOWED_ORIGINS = [
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "null",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

ALLOWED_ACTIONS = {"click", "type", "check", "radio", "select"}

TYPE_TO_ACTION = {
    "button": {"click"},
    "text-input": {"type"},
    "checkbox": {"check"},
    "radio": {"radio"},
    "select": {"select"},
}

OLLAMA_MODELL = "qwen2.5:3b"


class WebElement(BaseModel):
    id: str
    typ: str
    text: str
    note: Optional[str] = ""
    isNavigationLin: Optional[bool] = False
    formId: Optional[str] = None
    isSubmit: Optional[bool] = False
    options: Optional[list[str]] = None


class WebData(BaseModel):
    spoken_text: str
    elements: list[WebElement]


SYSTEM_INSTRUCTION = (
    "You are a generic AI for an accessibility/voice control plugin that runs on "
    "ANY websites. You do NOT know the website in advance—your only "
    "source of information is the 'Available Elements' list, which is freshly "
    "scanned from the CURRENT page with every request. This means that all elements in this list are "
    "already on the page where the user is NOW.\n\n"

    "ELEMENT STRUCTURE:\n"
    "- 'id': unique ID; MUST be copied exactly for 'target_id'.\n"
    "- 'type': 'button', 'text-input', 'checkbox', 'radio', or 'select'.\n"
    "- 'text': visible text/label/placeholder of the element.\n"
    "- 'note': optional additional context provided by the developer; takes precedence over assumptions.\n"
    "- 'isNavigationLin': true if a click leads to a DIFFERENT page.\n"
    "- 'formId': Groups elements of the same <form>.\n"
    "- 'isSubmit': true if this button submits the form with the same formId.\n"
    "- 'options': For 'select', the selectable text options.\n\n"

    "CRITICAL RULE 1 - NO MADE-UP IDs: Use ONLY 'target_id' values that "
    "appear EXACTLY and WORD-FOR-WORD in the list. If no matching item exists, skip the "
    "step. NEVER guess a random item if nothing fits the theme.\n\n"

    "CRITICAL RULE 2 - NO UNNECESSARY NAVIGATION: Since ALL elements in the list already exist on "
    "the CURRENT page, you NEVER need a navigation click if the "
    "fields/buttons actually needed (text input, checkbox, radio, select, or a "
    "suitable submit button) are already in the list. Only click on an element with "
    "'isNavigationLin': true, if the current page does NOT contain a suitable element for the "
    "user's main request.\n\n"

    "CRITICAL RULE 3 - DO NOT USE EXISTING FIELDS FOR UNRELATED PURPOSES: If the current page "
    "does not contain an element relevant to the user's primary intent (e.g., the user "
    "wants to 'order food', but there is only a sick leave form field on this page), "
    "NEVER use a field/checkbox/button unrelated to the topic as a substitute. In this case, ONLY "
    "provide a click back to the appropriate navigation link (if available) and nothing else.\n\n"

    "AUTOMATICALLY SUBMIT FORMS: If the user fills in a field/checkbox with a 'formId' "
    "and there is a button with the SAME formId and 'isSubmit': true, automatically add a 'click' on that button at the "
    "END, even without an explicit 'submit'.\n\n"

    "MULTIPLE STEPS: If there are multiple requests in a single sentence, create a "
    "separate object for EACH step, in the correct order.\n\n"

    "PARTIAL IMPLEMENTATION: Perform as many steps as possible. Return [] ONLY if "
    "ABSOLUTELY NO element matches, not even navigation.\n\n"

    "ACTIONS (only applicable to the element type):\n"
    "- 'click': only for 'button'.\n"
    "- 'type': only for 'text-input'. Text MUST be entered in the 'value' field.\n"
    "- 'check': only for 'checkbox'. 'value' MUST be 'true' or 'false'.\n"
    "- 'radio': only for 'radio'.\n"
    "- 'select': only for 'select'. 'value' MUST match exactly one option from 'options'.\n\n"

    "Respond ONLY with a JSON list, without Markdown, without any explanation:\n"
    "[\n"
    '  {"action": "click"|"type"|"check"|"radio"|"select", "target_id": "ELEMENT_ID", "value": "TEXT_ODER_TRUE_ODER_LEER"}\n'
    "]"
)


def clean_llm_response(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        parts = text.split("```")
        if len(parts) >= 2:
            text = parts[1]
            if text.startswith("json"):
                text = text[4:]
    return text.strip()


STOPWORDS = {
    "the", "the", "the", "a", "a", "a", "a", "a", "and", 'or', "is",
    "it", "I", "my", "mine", "my", "my", "can", "please", 'can', "you",
    "to", "the", "the", "in", 'in', "not", "has", "itself", "on", "for", 'with', "from",
    "she", "we", "you", "are", "was", "will", "was", "have", "if", 'because', "that",
}


def tokenize(text: str) -> set:
    cleaned = "".join(ch.lower() if ch.isalnum() else " " for ch in text)
    words = {w for w in cleaned.split() if len(w) > 2 and w not in STOPWORDS}
    return words


def words_similar(a: str, b: str) -> bool:
    short, long = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) < 4:
        return a == b
    return short in long


def has_overlap(command_tokens: set, comparison_tokens: set) -> bool:
    if not comparison_tokens:
        return True
    for bt in command_tokens:
        for vt in comparison_tokens:
            if words_similar(bt, vt):
                return True
    return False


def has_a_thematic_connection(command_tokens: set, element: WebElement) -> bool:
    element_text = f"{element.text} {element.note or ''}"
    return has_overlap(command_tokens, tokenize(element_text))


def validate_actions(actions, elements: list[WebElement], spoken_text: str) -> list[dict]:
    element_map = {e.id: e for e in elements}

    if not isinstance(actions, list):
        actions = []

    command_tokens = tokenize(spoken_text)

    rawList = []
    for entry in actions:
        if not isinstance(entry, dict):
            continue

        action = entry.get("action")
        target_id = entry.get("target_id")
        value = entry.get("value", "")

        if action not in ALLOWED_ACTIONS or not target_id:
            continue
        if target_id not in element_map:
            logger.warning("Rejected: fictitious/unknown target_id '%s'", target_id)
            continue

        element = element_map[target_id]
        if action not in TYPE_TO_ACTION.get(element.typ, set()):
            logger.warning("Rejected: Action '%s' does not match the type '%s' (target_id='%s')", action, element.typ, target_id)
            continue

        rawList.append({"action": action, "target_id": target_id, "value": value})

    for entry in list(rawList):
        if entry["action"] != "click":
            continue
        element = element_map[entry["target_id"]]
        if not element.isNavigationLin or element.isSubmit:
            continue
        if has_a_thematic_connection(command_tokens, element):
            continue
        logger.warning(
            "Validation Check (Navigation): '%s' (Text='%s') has no connection to the text — rejected.",
            entry["target_id"], element.text
        )
        rawList.remove(entry)

    for entry in list(rawList):
        if entry["action"] not in ("type", "check", "radio", "select"):
            continue
        element = element_map[entry["target_id"]]

        reference_via_element = has_a_thematic_connection(command_tokens, element)
        value_tokens = tokenize(str(entry.get("value", "")))
        reference_by_value = has_overlap(command_tokens, value_tokens) if value_tokens else True

        if reference_via_element or reference_by_value:
            continue

        logger.warning(
            "Validation Check (Form Field): '%s' (Text='%s', value='%s') has no connection to "
            "Command — rejected (possible misuse).",
            entry["target_id"], element.text, entry.get("value", "")
        )
        rawList.remove(entry)

    hat_lokale_formular_aktion = any(a["action"] in ("type", "check", "radio", "select") for a in rawList)

    if hat_lokale_formular_aktion:
        cleaned = []
        for entry in rawList:
            element = element_map[entry["target_id"]]
            ist_navigations_klick = entry["action"] == "click" and element.isNavigationLin
            if ist_navigations_klick:
                logger.warning(
                    "Validation Check (Navigation): Navigation-Click on '%s' rejected, as target elements "
                    "are already present on the current page.", entry["target_id"]
                )
                continue
            cleaned.append(entry)
        rawList = cleaned

    valid = rawList

    already_clicked = {a["target_id"] for a in valid if a["action"] == "click"}
    served_form_ids = {
        element_map[a["target_id"]].formId
        for a in valid
        if element_map[a["target_id"]].formId and a["action"] in ("type", "check", "radio", "select")
    }

    for form_id in served_form_ids:
        for element in elements:
            is_appropriate_submit = (
                element.formId == form_id
                and element.isSubmit
                and element.id not in already_clicked
            )
            if is_appropriate_submit:
                logger.info("Generic Submit Fix: Click \"Add\" '%s' (formId=%s)", element.id, form_id)
                valid.append({"action": "click", "target_id": element.id, "value": ""})
                already_clicked.add(element.id)

    return valid


@app.post("/analyze-command")
def analyze_command(daten: WebData):
    logger.info("The User said: %s", daten.spoken_text)

    elemente_dicts = [e.model_dump(exclude_none=True) for e in daten.elements]
    user_prompt = (
        f"Available Elements:\n{json.dumps(elemente_dicts, ensure_ascii=False)}\n\n"
        f'Voice command: "{daten.spoken_text}"'
    )

    try:
        response = ollama.chat(
            model=OLLAMA_MODELL,
            messages=[
                {"role": "system", "content": SYSTEM_INSTRUCTION},
                {"role": "user", "content": user_prompt},
            ],
            options={"temperature": 0.0},
        )
    except Exception as error:
        logger.error("Ollama-Fehler: %s", error)
        raise HTTPException(status_code=503, detail="AI model not available. Is Ollama running?")

    ai_response_text = response["message"]["content"]
    logger.info("Rohantwort: %s", ai_response_text)

    cleaned = clean_llm_response(ai_response_text)

    try:
        actions_list = json.loads(cleaned)
    except json.JSONDecodeError as error:
        logger.error("JSON parsing failed: %s", error)
        return [{"action": "error", "target_id": None, "value": None}]

    if isinstance(actions_list, dict):
        actions_list = [actions_list]

    valid_actions = validate_actions(actions_list, daten.elements, daten.spoken_text)

    if not valid_actions:
        logger.warning("No valid actions remain after validation.")
        return [{"action": "error", "target_id": None, "value": None}]

    return valid_actions


app.mount("/", StaticFiles(directory=".", html=True), name="static")