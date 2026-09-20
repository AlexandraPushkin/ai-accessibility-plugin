(function () {
    "use strict";

    const CONFIG = Object.assign(
        {
            backendUrl: "http://127.0.0.1:8000/befehl-analysieren",
            language: "de-DE",
            highlightDauer: 650,
            residualEffectDuration: 400,
            requestTimeoutMs: 15000,
            maxAutoRetries: 1,
        },
        window.KI_PLUGIN_CONFIG || {}
    );

    // ============================================================================
    // 1. INSERT GUI
    // ============================================================================
    const aiHTML = `
        <div id="ai-plugin-wrapper" style="position: fixed; bottom: 30px; right: 30px; display: flex; flex-direction: column; align-items: flex-end; font-family: sans-serif; z-index: 999999;">
            <div id="ai-box" class="ai-box">
                <div id="ai-title" class="ai-title">AI Assistant</div>
                <p id="ai-text" class="ai-text">Bereit.</p>
                <div id="ai-preview" class="ai-preview"></div>
            </div>
            <button id="ai-btn" class="ai-btn" aria-label="Launch the voice assistant" type="button">🎙️</button>
        </div>
    `;
    document.body.insertAdjacentHTML("beforeend", aiHTML);

    const styleTag = document.createElement("style");
    styleTag.textContent = `
        .ai-box {
            background: #2c3e50; color: white; padding: 15px 20px; border-radius: 14px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2); margin-bottom: 15px; width: 280px;
            display: none; opacity: 0; transform: translateY(8px) scale(0.98);
            transition: opacity 220ms cubic-bezier(0.16,1,0.3,1), transform 220ms cubic-bezier(0.16,1,0.3,1);
        }
        .ai-box.visible { display: block; opacity: 1; transform: translateY(0) scale(1); }
        .ai-title { font-weight: bold; font-size: 14px; margin-bottom: 5px; color: #47a8bd; }
        .ai-text { font-size: 13px; color: #ccc; margin: 0; }
        .ai-preview { font-style: italic; color: #fff; font-size: 15px; margin-top: 8px; min-height: 18px; }
        .ai-btn {
            width: 66px; height: 66px; border-radius: 50%;
            background: linear-gradient(135deg, #7047bd, #35607d);
            color: white; border: none; cursor: pointer;
            box-shadow: 0 6px 20px rgba(52, 152, 219, 0.4);
            display: flex; align-items: center; justify-content: center; font-size: 26px;
            transition: transform 180ms cubic-bezier(0.16,1,0.3,1), box-shadow 180ms cubic-bezier(0.16,1,0.3,1);
        }
        .ai-btn:hover { transform: scale(1.06); box-shadow: 0 10px 26px rgba(52,152,219,0.5); }
        .ai-btn:active { transform: scale(0.94); }
        .ai-btn.listening { animation: ki-pulse 1.4s ease-in-out infinite; background: linear-gradient(135deg, #e74c3c, #c0392b); }
        @keyframes ki-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(231,76,60,0.5); }
            50% { box-shadow: 0 0 0 14px rgba(231,76,60,0); }
        }
        .ai-highlight {
            outline: 4px solid #8e44ad !important;
            outline-offset: 3px;
            border-radius: 8px;
            box-shadow: 0 0 0 6px rgba(142, 68, 173, 0.25) !important;
            animation: ai-highlight-pulse 900ms ease-in-out 2;
            position: relative;
            z-index: 999998;
        }
        .ai-highlight.ai-type { outline-color: #9c29b9 !important; box-shadow: 0 0 0 6px rgba(41,128,185,0.25) !important; }
        .ai-highlight.ai-check,
        .ai-highlight.ai-radio,
        .ai-highlight.ai-select { outline-color: #27ae60 !important; box-shadow: 0 0 0 6px rgba(39,174,96,0.25) !important; }
        @keyframes ai-highlight-pulse { 0%, 100% { outline-offset: 3px; } 50% { outline-offset: 7px; } }
        @media (prefers-reduced-motion: reduce) {
            .ai-box, .ai-btn, .ai-highlight { transition: none !important; animation: none !important; }
        }
    `;
    document.head.appendChild(styleTag);

    const aiBtn = document.getElementById("ai-btn");
    const aiBox = document.getElementById("ai-box");
    const aiTitle = document.getElementById("ai-title");
    const aiText = document.getElementById("ai-text");
    const aiPreview = document.getElementById("ai-preview");

    let hideTimer = null;
    let idCounter = 0;

    function newAutoId(prefix) {
        idCounter += 1;
        return `ki-auto-${prefix}-${idCounter}`;
    }

    // ============================================================================
    // 2. GENERIC PAGE SCAN
    // ============================================================================
    function findDescription(el, fallback) {
        if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
        if (el.id) {
            const label = document.querySelector(`label[for="${el.id}"]`);
            if (label) return label.innerText.trim();
        }
        const parentLabel = el.closest("label");
        if (parentLabel) return parentLabel.innerText.trim();
        const prev = el.previousElementSibling;
        if (prev && prev.tagName === "LABEL") return prev.innerText.trim();
        if (el.placeholder) return el.placeholder;
        if (el.innerText && el.innerText.trim()) return el.innerText.trim();
        return fallback || "";
    }

    function findFormGroup(el) {
        const form = el.closest("form");
        if (!form) return null;
        if (!form.id) form.id = newAutoId("form");
        return form.id;
    }

    function isSameOriginLink(el) {
        if (el.tagName.toLowerCase() !== "a") return false;
        const href = el.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
            return false;
        }
        try {
            const url = new URL(href, window.location.href);
            return url.origin === window.location.origin;
        } catch (e) {
            return false;
        }
    }

    function scanWebsite() {
        const foundElements = [];
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const EXCLUDED = "#ai-plugin-wrapper, #ai-plugin-wrapper *";

        document.querySelectorAll('button, a[href], input[type="submit"], input[type="button"]').forEach((el) => {
            if (el.matches(EXCLUDED) || el.hasAttribute("data-ai-ignore") || !visible(el)) return;
            if (!el.id) el.id = newAutoId("btn");

            const isLink = el.tagName.toLowerCase() === "a";
            const isSubmitType = el.type === "submit" || el.hasAttribute("data-ai-submit");
            const formId = findFormGroup(el);

            foundElements.push({
                id: el.id,
                typ: "button",
                text: findDescription(el, el.id),
                note: el.getAttribute("data-ai-hint") || "",
                isNavigationLink: isLink && isSameOriginLink(el),
                formId: formId,
                isSubmit: isSubmitType,
            });
        });

        document
            .querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="search"], input[type="password"], input[type="url"], input:not([type]), textarea')
            .forEach((el) => {
                if (el.matches(EXCLUDED) || el.hasAttribute("data-ai-ignore") || !visible(el)) return;
                if (!el.id) el.id = newAutoId("input");

                foundElements.push({
                    id: el.id,
                    typ: "text-input",
                    text: findDescription(el, el.id),
                    note: el.getAttribute("data-ai-hint") || "",
                    formId: findFormGroup(el),
                });
            });

        document.querySelectorAll('input[type="checkbox"]').forEach((el) => {
            if (el.matches(EXCLUDED) || el.hasAttribute("data-ai-ignore") || !visible(el)) return;
            if (!el.id) el.id = newAutoId("check");

            foundElements.push({
                id: el.id,
                typ: "checkbox",
                text: findDescription(el, "Checkbox"),
                note: el.getAttribute("data-ai-hint") || "",
                formId: findFormGroup(el),
            });
        });

        document.querySelectorAll('input[type="radio"]').forEach((el) => {
            if (el.matches(EXCLUDED) || el.hasAttribute("data-ai-ignore") || !visible(el)) return;
            if (!el.id) el.id = newAutoId("radio");

            foundElements.push({
                id: el.id,
                typ: "radio",
                text: findDescription(el, el.name || "Option"),
                note: el.getAttribute("data-ai-hint") || "",
                formId: findFormGroup(el),
            });
        });

        document.querySelectorAll("select").forEach((el) => {
            if (el.matches(EXCLUDED) || el.hasAttribute("data-ai-ignore") || !visible(el)) return;
            if (!el.id) el.id = newAutoId("select");

            const optionen = Array.from(el.options).map((o) => o.text.trim());
            foundElements.push({
                id: el.id,
                typ: "select",
                text: findDescription(el, "Auswahl"),
                note: el.getAttribute("data-ai-hint") || "",
                formId: findFormGroup(el),
                optionen: optionen,
            });
        });

        return foundElements;
    }

    // ============================================================================
    // 3. STATUS INDICATOR
    // ============================================================================
    function setStatus(condition, detailText = "", previewText = "") {
        clearTimeout(hideTimer);
        aiBox.classList.add("visible");

        if (condition === "listening") {
            aiBtn.innerText = "🛑";
            aiBtn.classList.add("listening");
            aiTitle.innerText = "I'm listening...";
            aiText.innerText = "Tell me what you'd like to do...";
            aiPreview.innerText = "";
        } else if (condition === "thinking") {
            aiBtn.innerText = "🧠";
            aiBtn.classList.remove("listening");
            aiTitle.innerText = "AI is thinking...";
            aiText.innerText = "Processing...";
            aiPreview.innerText = `"${previewText}"`;
        } else if (condition === "success") {
            aiBtn.innerText = "✔️";
            aiBtn.classList.remove("listening");
            aiTitle.innerText = "Completed!";
            aiText.innerText = detailText;
            hideTimer = setTimeout(resetUI, 3000);
        } else if (condition === "error") {
            aiBtn.innerText = "❌";
            aiBtn.classList.remove("listening");
            aiTitle.innerText = "Error";
            aiText.innerText = detailText;
            hideTimer = setTimeout(resetUI, 4000);
        }
    }

    function resetUI() {
        aiBox.classList.remove("visible");
        aiBtn.innerText = "🎙️";
        aiBtn.classList.remove("listening");
    }

    // ============================================================================
    // 4. BACK-END COMMUNICATION & IMPLEMENTATION
    // ============================================================================
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let currentRequest = null;

    async function sendToBackend(spokenText, elementsList, retryCounter = 0) {
        setStatus("thinking", "", spokenText);

        if (currentRequest) currentRequest.abort();
        const controller = new AbortController();
        currentRequest = controller;
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

        try {
            const answer = await fetch(CONFIG.backendUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ spoken_text: spokenText, elemente: elementsList }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!answer.ok) {
                setStatus("error", `ServerError (${answer.status}).`);
                return;
            }

            const actions = await answer.json();
            if (!Array.isArray(actions) || actions.length === 0) {
                setStatus("error", "No valid response was received.");
                return;
            }

            let successReports = [];

            for (const data of actions) {
                if (data.action === "error" || !data.target_id) continue;

                const targetElement = document.getElementById(data.target_id);
                if (!targetElement) continue;

                targetElement.scrollIntoView({ behavior: "smooth", block: "center" });
                const highlightClass = `kiga-${data.action}`;
                targetElement.classList.add("ai-highlight", highlightClass);

                const previewTexts = { click: "Click on: ", type: "Type in: ", check: "Check: ", radio: "Select: ", select: "Select from: " };
                const displayText = (targetElement.innerText || targetElement.placeholder || data.target_id || "").trim();
                aiPreview.innerText = `${previewTexts[data.action] || ""}${displayText}`;

                await wait(CONFIG.highlightDauer);

                // Navigation logic: If we are already on the destination page, the
                // click is SKIPPED, but still counted as a success (Fix: otherwise
                // the message “Command could not be mapped” appears incorrectly).
                if (data.action === "click" && targetElement.tagName.toLowerCase() === "a" && isSameOriginLink(targetElement)) {
                    const targetUrl = targetElement.getAttribute("href");
                    const absoluteTargetUrl = new URL(targetUrl, window.location.href);
                    const alreadyOnLandingPage = absoluteTargetUrl.pathname === window.location.pathname;

                    if (alreadyOnLandingPage) {
                        targetElement.classList.remove("ai-highlight", highlightClass);
                        successReports.push("Already on the right page");
                        continue;
                    }

                    if (retryCounter >= CONFIG.maxAutoRetries) {
                        console.warn(`AI Plugin: Anti-Loop Protection - Page Break After ${retryCounter} Retries blocked.`);
                        setStatus("error", "The command could not be unambiguously identified.");
                        return;
                    }

                    sessionStorage.setItem("ai_plugin_pending_command", spokenText);
                    sessionStorage.setItem("ai_plugin_retry_count", String(retryCounter + 1));
                    setStatus("success", "Go to page...");
                    await wait(300);
                    window.location.href = targetUrl;
                    return;
                }

                if (data.action === "type") {
                    targetElement.value = data.value;
                    targetElement.dispatchEvent(new Event("input", { bubbles: true }));
                    successReports.push(`Registered: "${data.value}"`);
                } else if (data.action === "check") {
                    const shouldBeActive = data.value === "" || data.value === true || data.value === "true";
                    targetElement.checked = shouldBeActive;
                    targetElement.dispatchEvent(new Event("change", { bubbles: true }));
                    successReports.push(shouldBeActive ? "Enabled" : "Disabled");
                } else if (data.action === "radio") {
                    targetElement.checked = true;
                    targetElement.dispatchEvent(new Event("change", { bubbles: true }));
                    successReports.push("Option selected");
                } else if (data.action === "select") {
                    const optionsList = Array.from(targetElement.options);
                    const matches = optionsList.find(
                        (o) => o.text.trim().toLowerCase() === String(data.value).trim().toLowerCase()
                    );
                    if (matches) {
                        targetElement.value = matches.value;
                        targetElement.dispatchEvent(new Event("change", { bubbles: true }));
                        successReports.push(`Selected: "${matches.text}"`);
                    }
                } else if (data.action === "click") {
                    targetElement.click();
                    successReports.push("Button clicked");
                }

                await wait(CONFIG.residualEffectDuration);
                targetElement.classList.remove("ai-highlight", highlightClass);
            }

            setStatus(
                successReports.length > 0 ? "success" : "error",
                successReports.length > 0 ? successReports.join(" & ") : "The command could not be assigned."
            );
        } catch (error) {
            clearTimeout(timeoutId);
            setStatus("error", error.name === "AbortError" ? "Timeout: The server response timed out." : "Server connection failed.");
        } finally {
            currentRequest = null;
        }
    }

    // ============================================================================
    // 5. AUTOMATIC CONTINUATION AFTER A PAGE BREAK
    // ============================================================================
    window.addEventListener("DOMContentLoaded", () => {
        const openCommand = sessionStorage.getItem("ai_plugin_pending_command");
        const retryCounter = parseInt(sessionStorage.getItem("ai_plugin_retry_count") || "0", 10);

        if (openCommand) {
            sessionStorage.removeItem("ai_plugin_pending_command");
            sessionStorage.removeItem("ai_plugin_retry_count");
            setTimeout(() => sendToBackend(openCommand, scanWebsite(), retryCounter), 700);
        }
    });

    // ============================================================================
    // 6. WEB SPEECH API
    // ============================================================================
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.lang = CONFIG.language;
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        aiBtn.addEventListener("click", () => {
            if (aiBtn.classList.contains("listening")) {
                recognition.stop();
                resetUI();
            } else {
                try {
                    recognition.start();
                    setStatus("listening");
                } catch (e) {
                    setStatus("error", "The microphone could not be started.");
                }
            }
        });

        recognition.onresult = (event) => {
            const text = event.results[0][0].transcript;
            sendToBackend(text, scanWebsite(), 0);
        };

        recognition.onerror = (event) => {
            const meldungen = {
                "not-allowed": "Microphone access denied.",
                "no-speech": "No speech detected. Please try again.",
                "audio-capture": "No microphone found.",
            };
            setStatus("error", meldungen[event.error] || "Speech recognition failed.");
        };

        recognition.onend = () => {
            if (aiBtn.classList.contains("listening")) {
                aiBtn.classList.remove("listening");
                aiBtn.innerText = "🎙️";
            }
        };
    } else {
        aiBtn.addEventListener("click", () => {
            setStatus("error", "Speech recognition is not supported by this browser. Please use Chrome or Edge.");
        });
    }
})();