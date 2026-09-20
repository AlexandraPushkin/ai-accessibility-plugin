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

ERLAUBTE_ORIGINS = [
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "null",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ERLAUBTE_ORIGINS,
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

ERLAUBTE_AKTIONEN = {"click", "type", "check", "radio", "select"}

TYP_ZU_AKTION = {
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
    hinweis: Optional[str] = ""
    istNavigationsLink: Optional[bool] = False
    formId: Optional[str] = None
    istSubmit: Optional[bool] = False
    optionen: Optional[list[str]] = None


class WebDaten(BaseModel):
    gesprochener_text: str
    elemente: list[WebElement]


SYSTEM_ANWEISUNG = (
    "Du bist eine generische KI fuer ein Barrierefreiheits-/Sprachsteuerungs-Plugin, das auf "
    "BELIEBIGEN Webseiten laeuft. Du kennst die Webseite NICHT im Voraus - deine einzige "
    "Informationsquelle ist die Liste 'Verfuegbare Elemente', die bei jeder Anfrage frisch "
    "von der AKTUELLEN Seite gescannt wurde. Alle Elemente in dieser Liste befinden sich also "
    "bereits auf der Seite, auf der sich der Nutzer JETZT befindet.\n\n"

    "STRUKTUR DER ELEMENTE:\n"
    "- 'id': eindeutige ID, MUSS exakt fuer 'ziel_id' uebernommen werden.\n"
    "- 'typ': 'button', 'text-input', 'checkbox', 'radio' oder 'select'.\n"
    "- 'text': sichtbarer Text/Label/Platzhalter des Elements.\n"
    "- 'hinweis': optionaler Zusatz-Kontext des Entwicklers, hat Vorrang vor Vermutungen.\n"
    "- 'istNavigationsLink': true, wenn ein Klick zu einer ANDEREN Seite fuehrt.\n"
    "- 'formId': gruppiert Elemente desselben <form>.\n"
    "- 'istSubmit': true, wenn dieser Button das Formular mit gleicher formId absendet.\n"
    "- 'optionen': bei 'select' die waehlbaren Texte.\n\n"

    "KRITISCHE REGEL 1 - KEINE ERFUNDENEN IDs: Verwende AUSSCHLIESSLICH 'ziel_id'-Werte, die "
    "EXAKT und WORTWOERTLICH in der Liste vorkommen. Existiert kein passendes Element, lasse den "
    "Schritt weg. Rate NIEMALS ein zufaelliges Element, wenn nichts thematisch passt.\n\n"

    "KRITISCHE REGEL 2 - KEINE UNNOETIGE NAVIGATION: Da ALLE Elemente in der Liste bereits auf "
    "der AKTUELLEN Seite existieren, brauchst du NIEMALS einen Navigations-Klick, wenn die "
    "eigentlich benoetigten Felder/Buttons (text-input, checkbox, radio, select, oder ein "
    "passender Absende-Button) schon in der Liste stehen. Klicke nur auf ein Element mit "
    "'istNavigationsLink': true, wenn die aktuelle Seite KEIN passendes Element fuer den "
    "Hauptwunsch des Nutzers enthaelt.\n\n"

    "KRITISCHE REGEL 3 - KEINE ZWECKENTFREMDUNG VORHANDENER FELDER: Wenn die aktuelle Seite "
    "KEIN thematisch passendes Element fuer den Hauptwunsch des Nutzers enthaelt (z.B. Nutzer "
    "will 'Essen bestellen', aber es gibt nur ein Krankmeldungs-Feld auf dieser Seite), "
    "verwende NIEMALS ein themenfremdes Feld/Checkbox/Button als Ersatz. Gib in diesem Fall NUR "
    "einen Klick auf den passenden Navigations-Link zurueck (falls vorhanden) und sonst nichts.\n\n"

    "FORMULARE AUTOMATISCH ABSENDEN: Wenn der Nutzer ein Feld/eine Checkbox mit einer 'formId' "
    "ausfuellt und es einen Button mit DERSELBEN formId und 'istSubmit': true gibt, fuege am "
    "ENDE automatisch einen 'click' auf diesen Button hinzu, auch ohne explizites 'absenden'.\n\n"

    "MEHRERE SCHRITTE: Bei mehreren Wuenschen in einem Satz erstelle fuer JEDEN Schritt ein "
    "eigenes Objekt, in der richtigen Reihenfolge.\n\n"

    "TEILWEISE AUSFUEHRUNG: Fuehre so viele Schritte wie moeglich aus. Gib NUR [] zurueck, wenn "
    "ABSOLUT KEIN Element passt, auch keine Navigation.\n\n"

    "AKTIONEN (nur passend zum Element-Typ):\n"
    "- 'click': nur fuer 'button'.\n"
    "- 'type': nur fuer 'text-input'. Text MUSS im Feld 'wert' stehen.\n"
    "- 'check': nur fuer 'checkbox'. 'wert' MUSS 'true' oder 'false' sein.\n"
    "- 'radio': nur fuer 'radio'.\n"
    "- 'select': nur fuer 'select'. 'wert' MUSS exakt einer Option aus 'optionen' entsprechen.\n\n"

    "Antworte AUSSCHLIESSLICH mit einer JSON-Liste, ohne Markdown, ohne Erklaerung:\n"
    "[\n"
    '  {"aktion": "click"|"type"|"check"|"radio"|"select", "ziel_id": "ELEMENT_ID", "wert": "TEXT_ODER_TRUE_ODER_LEER"}\n'
    "]"
)


def bereinige_llm_antwort(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        teile = text.split("```")
        if len(teile) >= 2:
            text = teile[1]
            if text.startswith("json"):
                text = text[4:]
    return text.strip()


STOPPWOERTER = {
    "der", "die", "das", "ein", "eine", "einen", "einem", "einer", "und", "oder", "ist",
    "es", "ich", "mein", "meine", "meinen", "meinem", "kann", "bitte", "kannst", "du",
    "zu", "den", "dem", "im", "in", "nicht", "hat", "sich", "auf", "fuer", "mit", "von",
    "sie", "wir", "ihr", "sind", "war", "wird", "wurde", "haben", "wenn", "weil", "dass",
}


def tokenisiere(text: str) -> set:
    bereinigt = "".join(ch.lower() if ch.isalnum() else " " for ch in text)
    woerter = {w for w in bereinigt.split() if len(w) > 2 and w not in STOPPWOERTER}
    return woerter


def woerter_aehnlich(a: str, b: str) -> bool:
    kurz, lang = (a, b) if len(a) <= len(b) else (b, a)
    if len(kurz) < 4:
        return a == b
    return kurz in lang


def hat_ueberlappung(befehl_tokens: set, vergleichs_tokens: set) -> bool:
    if not vergleichs_tokens:
        return True
    for bt in befehl_tokens:
        for vt in vergleichs_tokens:
            if woerter_aehnlich(bt, vt):
                return True
    return False


def hat_thematischen_bezug(befehl_tokens: set, element: WebElement) -> bool:
    element_text = f"{element.text} {element.hinweis or ''}"
    return hat_ueberlappung(befehl_tokens, tokenisiere(element_text))


def validiere_aktionen(aktionen, elemente: list[WebElement], gesprochener_text: str) -> list[dict]:
    element_map = {e.id: e for e in elemente}

    if not isinstance(aktionen, list):
        aktionen = []

    befehl_tokens = tokenisiere(gesprochener_text)

    rohliste = []
    for eintrag in aktionen:
        if not isinstance(eintrag, dict):
            continue

        aktion = eintrag.get("aktion")
        ziel_id = eintrag.get("ziel_id")
        wert = eintrag.get("wert", "")

        if aktion not in ERLAUBTE_AKTIONEN or not ziel_id:
            continue
        if ziel_id not in element_map:
            logger.warning("Verworfen: erfundene/unbekannte ziel_id '%s'", ziel_id)
            continue

        element = element_map[ziel_id]
        if aktion not in TYP_ZU_AKTION.get(element.typ, set()):
            logger.warning("Verworfen: Aktion '%s' passt nicht zu Typ '%s' (ziel_id='%s')", aktion, element.typ, ziel_id)
            continue

        rohliste.append({"aktion": aktion, "ziel_id": ziel_id, "wert": wert})

    for eintrag in list(rohliste):
        if eintrag["aktion"] != "click":
            continue
        element = element_map[eintrag["ziel_id"]]
        if not element.istNavigationsLink or element.istSubmit:
            continue
        if hat_thematischen_bezug(befehl_tokens, element):
            continue
        logger.warning(
            "Plausibilitaetscheck (Navigation): '%s' (Text='%s') hat keinen Wortbezug - verworfen.",
            eintrag["ziel_id"], element.text
        )
        rohliste.remove(eintrag)

    for eintrag in list(rohliste):
        if eintrag["aktion"] not in ("type", "check", "radio", "select"):
            continue
        element = element_map[eintrag["ziel_id"]]

        bezug_ueber_element = hat_thematischen_bezug(befehl_tokens, element)
        wert_tokens = tokenisiere(str(eintrag.get("wert", "")))
        bezug_ueber_wert = hat_ueberlappung(befehl_tokens, wert_tokens) if wert_tokens else True

        if bezug_ueber_element or bezug_ueber_wert:
            continue

        logger.warning(
            "Plausibilitaetscheck (Formularfeld): '%s' (Text='%s', wert='%s') hat keinen Wortbezug "
            "zum Befehl - verworfen (moegliche Zweckentfremdung).",
            eintrag["ziel_id"], element.text, eintrag.get("wert", "")
        )
        rohliste.remove(eintrag)

    hat_lokale_formular_aktion = any(a["aktion"] in ("type", "check", "radio", "select") for a in rohliste)

    if hat_lokale_formular_aktion:
        bereinigt = []
        for eintrag in rohliste:
            element = element_map[eintrag["ziel_id"]]
            ist_navigations_klick = eintrag["aktion"] == "click" and element.istNavigationsLink
            if ist_navigations_klick:
                logger.warning(
                    "Widerspruchs-Check: Navigations-Klick auf '%s' verworfen, da Zielelemente "
                    "bereits auf aktueller Seite vorhanden sind.", eintrag["ziel_id"]
                )
                continue
            bereinigt.append(eintrag)
        rohliste = bereinigt

    gueltig = rohliste

    bereits_geklickt = {a["ziel_id"] for a in gueltig if a["aktion"] == "click"}
    bediente_form_ids = {
        element_map[a["ziel_id"]].formId
        for a in gueltig
        if element_map[a["ziel_id"]].formId and a["aktion"] in ("type", "check", "radio", "select")
    }

    for form_id in bediente_form_ids:
        for element in elemente:
            ist_passender_submit = (
                element.formId == form_id
                and element.istSubmit
                and element.id not in bereits_geklickt
            )
            if ist_passender_submit:
                logger.info("Generischer Submit-Fix: ergaenze click auf '%s' (formId=%s)", element.id, form_id)
                gueltig.append({"aktion": "click", "ziel_id": element.id, "wert": ""})
                bereits_geklickt.add(element.id)

    return gueltig


@app.post("/befehl-analysieren")
def analysiere_befehl(daten: WebDaten):
    logger.info("Nutzer sagte: %s", daten.gesprochener_text)

    elemente_dicts = [e.model_dump(exclude_none=True) for e in daten.elemente]
    user_prompt = (
        f"Verfuegbare Elemente:\n{json.dumps(elemente_dicts, ensure_ascii=False)}\n\n"
        f'Sprachbefehl: "{daten.gesprochener_text}"'
    )

    try:
        response = ollama.chat(
            model=OLLAMA_MODELL,
            messages=[
                {"role": "system", "content": SYSTEM_ANWEISUNG},
                {"role": "user", "content": user_prompt},
            ],
            options={"temperature": 0.0},
        )
    except Exception as fehler:
        logger.error("Ollama-Fehler: %s", fehler)
        raise HTTPException(status_code=503, detail="KI-Modell nicht erreichbar. Laeuft Ollama?")

    ki_antwort_text = response["message"]["content"]
    logger.info("Rohantwort: %s", ki_antwort_text)

    bereinigt = bereinige_llm_antwort(ki_antwort_text)

    try:
        aktionen_liste = json.loads(bereinigt)
    except json.JSONDecodeError as fehler:
        logger.error("JSON-Parsing fehlgeschlagen: %s", fehler)
        return [{"aktion": "error", "ziel_id": None, "wert": None}]

    if isinstance(aktionen_liste, dict):
        aktionen_liste = [aktionen_liste]

    gueltige_aktionen = validiere_aktionen(aktionen_liste, daten.elemente, daten.gesprochener_text)

    if not gueltige_aktionen:
        logger.warning("Keine gueltigen Aktionen nach Validierung uebrig.")
        return [{"aktion": "error", "ziel_id": None, "wert": None}]

    return gueltige_aktionen


app.mount("/", StaticFiles(directory=".", html=True), name="static")