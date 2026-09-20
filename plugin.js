(function () {
    "use strict";

    const CONFIG = Object.assign(
        {
            backendUrl: "http://127.0.0.1:8000/befehl-analysieren",
            sprache: "de-DE",
            highlightDauer: 650,
            nachwirkDauer: 400,
            requestTimeoutMs: 15000,
            maxAutoRetries: 1,
        },
        window.KI_PLUGIN_CONFIG || {}
    );

    // ============================================================================
    // 1. GUI EINFUEGEN
    // ============================================================================
    const kiHTML = `
        <div id="ki-plugin-wrapper" style="position: fixed; bottom: 30px; right: 30px; display: flex; flex-direction: column; align-items: flex-end; font-family: sans-serif; z-index: 999999;">
            <div id="ki-box" class="ki-box">
                <div id="ki-title" class="ki-title">KI-Assistent</div>
                <p id="ki-text" class="ki-text">Bereit.</p>
                <div id="ki-preview" class="ki-preview"></div>
            </div>
            <button id="ki-btn" class="ki-btn" aria-label="Sprachassistent starten" type="button">🎙️</button>
        </div>
    `;
    document.body.insertAdjacentHTML("beforeend", kiHTML);

    const styleTag = document.createElement("style");
    styleTag.textContent = `
        .ki-box {
            background: #2c3e50; color: white; padding: 15px 20px; border-radius: 14px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2); margin-bottom: 15px; width: 280px;
            display: none; opacity: 0; transform: translateY(8px) scale(0.98);
            transition: opacity 220ms cubic-bezier(0.16,1,0.3,1), transform 220ms cubic-bezier(0.16,1,0.3,1);
        }
        .ki-box.visible { display: block; opacity: 1; transform: translateY(0) scale(1); }
        .ki-title { font-weight: bold; font-size: 14px; margin-bottom: 5px; color: #47a8bd; }
        .ki-text { font-size: 13px; color: #ccc; margin: 0; }
        .ki-preview { font-style: italic; color: #fff; font-size: 15px; margin-top: 8px; min-height: 18px; }
        .ki-btn {
            width: 66px; height: 66px; border-radius: 50%;
            background: linear-gradient(135deg, #7047bd, #35607d);
            color: white; border: none; cursor: pointer;
            box-shadow: 0 6px 20px rgba(52, 152, 219, 0.4);
            display: flex; align-items: center; justify-content: center; font-size: 26px;
            transition: transform 180ms cubic-bezier(0.16,1,0.3,1), box-shadow 180ms cubic-bezier(0.16,1,0.3,1);
        }
        .ki-btn:hover { transform: scale(1.06); box-shadow: 0 10px 26px rgba(52,152,219,0.5); }
        .ki-btn:active { transform: scale(0.94); }
        .ki-btn.listening { animation: ki-pulse 1.4s ease-in-out infinite; background: linear-gradient(135deg, #e74c3c, #c0392b); }
        @keyframes ki-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(231,76,60,0.5); }
            50% { box-shadow: 0 0 0 14px rgba(231,76,60,0); }
        }
        .kiga-highlight {
            outline: 4px solid #8e44ad !important;
            outline-offset: 3px;
            border-radius: 8px;
            box-shadow: 0 0 0 6px rgba(142, 68, 173, 0.25) !important;
            animation: kiga-highlight-pulse 900ms ease-in-out 2;
            position: relative;
            z-index: 999998;
        }
        .kiga-highlight.kiga-type { outline-color: #9c29b9 !important; box-shadow: 0 0 0 6px rgba(41,128,185,0.25) !important; }
        .kiga-highlight.kiga-check,
        .kiga-highlight.kiga-radio,
        .kiga-highlight.kiga-select { outline-color: #27ae60 !important; box-shadow: 0 0 0 6px rgba(39,174,96,0.25) !important; }
        @keyframes kiga-highlight-pulse { 0%, 100% { outline-offset: 3px; } 50% { outline-offset: 7px; } }
        @media (prefers-reduced-motion: reduce) {
            .ki-box, .ki-btn, .kiga-highlight { transition: none !important; animation: none !important; }
        }
    `;
    document.head.appendChild(styleTag);

    const kiBtn = document.getElementById("ki-btn");
    const kiBox = document.getElementById("ki-box");
    const kiTitle = document.getElementById("ki-title");
    const kiText = document.getElementById("ki-text");
    const kiPreview = document.getElementById("ki-preview");

    let hideTimer = null;
    let idZaehler = 0;

    function neueAutoId(praefix) {
        idZaehler += 1;
        return `ki-auto-${praefix}-${idZaehler}`;
    }

    // ============================================================================
    // 2. GENERISCHES SEITEN-SCANNEN
    // ============================================================================
    function ermittleBeschreibung(el, fallback) {
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

    function ermittleFormGruppe(el) {
        const form = el.closest("form");
        if (!form) return null;
        if (!form.id) form.id = neueAutoId("form");
        return form.id;
    }

    function istSameOriginLink(el) {
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

    function scanneWebsite() {
        const gefundeneElemente = [];
        const sichtbar = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const AUSGESCHLOSSEN = "#ki-plugin-wrapper, #ki-plugin-wrapper *";

        document.querySelectorAll('button, a[href], input[type="submit"], input[type="button"]').forEach((el) => {
            if (el.matches(AUSGESCHLOSSEN) || el.hasAttribute("data-ki-ignore") || !sichtbar(el)) return;
            if (!el.id) el.id = neueAutoId("btn");

            const istLink = el.tagName.toLowerCase() === "a";
            const istSubmitTyp = el.type === "submit" || el.hasAttribute("data-ki-submit");
            const formId = ermittleFormGruppe(el);

            gefundeneElemente.push({
                id: el.id,
                typ: "button",
                text: ermittleBeschreibung(el, el.id),
                hinweis: el.getAttribute("data-ki-hint") || "",
                istNavigationsLink: istLink && istSameOriginLink(el),
                formId: formId,
                istSubmit: istSubmitTyp,
            });
        });

        document
            .querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="search"], input[type="password"], input[type="url"], input:not([type]), textarea')
            .forEach((el) => {
                if (el.matches(AUSGESCHLOSSEN) || el.hasAttribute("data-ki-ignore") || !sichtbar(el)) return;
                if (!el.id) el.id = neueAutoId("input");

                gefundeneElemente.push({
                    id: el.id,
                    typ: "text-input",
                    text: ermittleBeschreibung(el, el.id),
                    hinweis: el.getAttribute("data-ki-hint") || "",
                    formId: ermittleFormGruppe(el),
                });
            });

        document.querySelectorAll('input[type="checkbox"]').forEach((el) => {
            if (el.matches(AUSGESCHLOSSEN) || el.hasAttribute("data-ki-ignore") || !sichtbar(el)) return;
            if (!el.id) el.id = neueAutoId("check");

            gefundeneElemente.push({
                id: el.id,
                typ: "checkbox",
                text: ermittleBeschreibung(el, "Checkbox"),
                hinweis: el.getAttribute("data-ki-hint") || "",
                formId: ermittleFormGruppe(el),
            });
        });

        document.querySelectorAll('input[type="radio"]').forEach((el) => {
            if (el.matches(AUSGESCHLOSSEN) || el.hasAttribute("data-ki-ignore") || !sichtbar(el)) return;
            if (!el.id) el.id = neueAutoId("radio");

            gefundeneElemente.push({
                id: el.id,
                typ: "radio",
                text: ermittleBeschreibung(el, el.name || "Option"),
                hinweis: el.getAttribute("data-ki-hint") || "",
                formId: ermittleFormGruppe(el),
            });
        });

        document.querySelectorAll("select").forEach((el) => {
            if (el.matches(AUSGESCHLOSSEN) || el.hasAttribute("data-ki-ignore") || !sichtbar(el)) return;
            if (!el.id) el.id = neueAutoId("select");

            const optionen = Array.from(el.options).map((o) => o.text.trim());
            gefundeneElemente.push({
                id: el.id,
                typ: "select",
                text: ermittleBeschreibung(el, "Auswahl"),
                hinweis: el.getAttribute("data-ki-hint") || "",
                formId: ermittleFormGruppe(el),
                optionen: optionen,
            });
        });

        return gefundeneElemente;
    }

    // ============================================================================
    // 3. STATUS-ANZEIGE
    // ============================================================================
    function setzeStatus(zustand, detailText = "", vorschauText = "") {
        clearTimeout(hideTimer);
        kiBox.classList.add("visible");

        if (zustand === "hoeren") {
            kiBtn.innerText = "🛑";
            kiBtn.classList.add("listening");
            kiTitle.innerText = "Ich höre zu...";
            kiText.innerText = "Sprechen Sie Ihren Wunsch...";
            kiPreview.innerText = "";
        } else if (zustand === "denken") {
            kiBtn.innerText = "🧠";
            kiBtn.classList.remove("listening");
            kiTitle.innerText = "KI denkt nach...";
            kiText.innerText = "Verarbeite...";
            kiPreview.innerText = `"${vorschauText}"`;
        } else if (zustand === "erfolg") {
            kiBtn.innerText = "✔️";
            kiBtn.classList.remove("listening");
            kiTitle.innerText = "Ausgeführt!";
            kiText.innerText = detailText;
            hideTimer = setTimeout(resetUI, 3000);
        } else if (zustand === "fehler") {
            kiBtn.innerText = "❌";
            kiBtn.classList.remove("listening");
            kiTitle.innerText = "Fehler";
            kiText.innerText = detailText;
            hideTimer = setTimeout(resetUI, 4000);
        }
    }

    function resetUI() {
        kiBox.classList.remove("visible");
        kiBtn.innerText = "🎙️";
        kiBtn.classList.remove("listening");
    }

    // ============================================================================
    // 4. BACKEND-KOMMUNIKATION & AUSFUEHRUNG
    // ============================================================================
    const warte = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let laufenderRequest = null;

    async function sendeAnBackend(gesprochenerText, elementeListe, retryZaehler = 0) {
        setzeStatus("denken", "", gesprochenerText);

        if (laufenderRequest) laufenderRequest.abort();
        const controller = new AbortController();
        laufenderRequest = controller;
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

        try {
            const antwort = await fetch(CONFIG.backendUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ gesprochener_text: gesprochenerText, elemente: elementeListe }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!antwort.ok) {
                setzeStatus("fehler", `Serverfehler (${antwort.status}).`);
                return;
            }

            const aktionen = await antwort.json();
            if (!Array.isArray(aktionen) || aktionen.length === 0) {
                setzeStatus("fehler", "Keine gültige Antwort erhalten.");
                return;
            }

            let erfolgsMeldungen = [];

            for (const daten of aktionen) {
                if (daten.aktion === "error" || !daten.ziel_id) continue;

                const zielElement = document.getElementById(daten.ziel_id);
                if (!zielElement) continue;

                zielElement.scrollIntoView({ behavior: "smooth", block: "center" });
                const highlightKlasse = `kiga-${daten.aktion}`;
                zielElement.classList.add("kiga-highlight", highlightKlasse);

                const vorschauTexte = { click: "Klicke auf: ", type: "Trage ein in: ", check: "Aktiviere: ", radio: "Wähle: ", select: "Wähle aus: " };
                const anzeigeText = (zielElement.innerText || zielElement.placeholder || daten.ziel_id || "").trim();
                kiPreview.innerText = `${vorschauTexte[daten.aktion] || ""}${anzeigeText}`;

                await warte(CONFIG.highlightDauer);

                // Navigations-Logik: Wenn wir bereits auf der Zielseite sind, wird der
                // Klick sinnvoll UEBERSPRUNGEN, aber als Erfolg gezaehlt (Fix: sonst
                // erscheint faelschlich "Befehl konnte nicht zugeordnet werden").
                if (daten.aktion === "click" && zielElement.tagName.toLowerCase() === "a" && istSameOriginLink(zielElement)) {
                    const zielUrl = zielElement.getAttribute("href");
                    const absoluteZielUrl = new URL(zielUrl, window.location.href);
                    const bereitsAufZielseite = absoluteZielUrl.pathname === window.location.pathname;

                    if (bereitsAufZielseite) {
                        zielElement.classList.remove("kiga-highlight", highlightKlasse);
                        erfolgsMeldungen.push("Bereits auf der richtigen Seite");
                        continue;
                    }

                    if (retryZaehler >= CONFIG.maxAutoRetries) {
                        console.warn(`KI-Plugin: Anti-Loop-Schutz - Seitenwechsel nach ${retryZaehler} Retries blockiert.`);
                        setzeStatus("fehler", "Befehl konnte nicht eindeutig zugeordnet werden.");
                        return;
                    }

                    sessionStorage.setItem("ki_plugin_pending_command", gesprochenerText);
                    sessionStorage.setItem("ki_plugin_retry_count", String(retryZaehler + 1));
                    setzeStatus("erfolg", "Wechsle zu Seite...");
                    await warte(300);
                    window.location.href = zielUrl;
                    return;
                }

                if (daten.aktion === "type") {
                    zielElement.value = daten.wert;
                    zielElement.dispatchEvent(new Event("input", { bubbles: true }));
                    erfolgsMeldungen.push(`Eingetragen: "${daten.wert}"`);
                } else if (daten.aktion === "check") {
                    const sollAktivSein = daten.wert === "" || daten.wert === true || daten.wert === "true";
                    zielElement.checked = sollAktivSein;
                    zielElement.dispatchEvent(new Event("change", { bubbles: true }));
                    erfolgsMeldungen.push(sollAktivSein ? "Aktiviert" : "Deaktiviert");
                } else if (daten.aktion === "radio") {
                    zielElement.checked = true;
                    zielElement.dispatchEvent(new Event("change", { bubbles: true }));
                    erfolgsMeldungen.push("Option gewählt");
                } else if (daten.aktion === "select") {
                    const optionsListe = Array.from(zielElement.options);
                    const treffer = optionsListe.find(
                        (o) => o.text.trim().toLowerCase() === String(daten.wert).trim().toLowerCase()
                    );
                    if (treffer) {
                        zielElement.value = treffer.value;
                        zielElement.dispatchEvent(new Event("change", { bubbles: true }));
                        erfolgsMeldungen.push(`Ausgewählt: "${treffer.text}"`);
                    }
                } else if (daten.aktion === "click") {
                    zielElement.click();
                    erfolgsMeldungen.push("Knopf geklickt");
                }

                await warte(CONFIG.nachwirkDauer);
                zielElement.classList.remove("kiga-highlight", highlightKlasse);
            }

            setzeStatus(
                erfolgsMeldungen.length > 0 ? "erfolg" : "fehler",
                erfolgsMeldungen.length > 0 ? erfolgsMeldungen.join(" & ") : "Befehl konnte nicht zugeordnet werden."
            );
        } catch (fehler) {
            clearTimeout(timeoutId);
            setzeStatus("fehler", fehler.name === "AbortError" ? "Zeitüberschreitung bei der Server-Antwort." : "Server-Verbindung fehlgeschlagen.");
        } finally {
            laufenderRequest = null;
        }
    }

    // ============================================================================
    // 5. AUTOMATISCHES FORTSETZEN NACH SEITENWECHSEL
    // ============================================================================
    window.addEventListener("DOMContentLoaded", () => {
        const offenerBefehl = sessionStorage.getItem("ki_plugin_pending_command");
        const retryZaehler = parseInt(sessionStorage.getItem("ki_plugin_retry_count") || "0", 10);

        if (offenerBefehl) {
            sessionStorage.removeItem("ki_plugin_pending_command");
            sessionStorage.removeItem("ki_plugin_retry_count");
            setTimeout(() => sendeAnBackend(offenerBefehl, scanneWebsite(), retryZaehler), 700);
        }
    });

    // ============================================================================
    // 6. WEB SPEECH API
    // ============================================================================
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.lang = CONFIG.sprache;
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        kiBtn.addEventListener("click", () => {
            if (kiBtn.classList.contains("listening")) {
                recognition.stop();
                resetUI();
            } else {
                try {
                    recognition.start();
                    setzeStatus("hoeren");
                } catch (e) {
                    setzeStatus("fehler", "Mikrofon konnte nicht gestartet werden.");
                }
            }
        });

        recognition.onresult = (event) => {
            const text = event.results[0][0].transcript;
            sendeAnBackend(text, scanneWebsite(), 0);
        };

        recognition.onerror = (event) => {
            const meldungen = {
                "not-allowed": "Mikrofon-Zugriff verweigert.",
                "no-speech": "Keine Sprache erkannt. Bitte erneut versuchen.",
                "audio-capture": "Kein Mikrofon gefunden.",
            };
            setzeStatus("fehler", meldungen[event.error] || "Spracherkennung fehlgeschlagen.");
        };

        recognition.onend = () => {
            if (kiBtn.classList.contains("listening")) {
                kiBtn.classList.remove("listening");
                kiBtn.innerText = "🎙️";
            }
        };
    } else {
        kiBtn.addEventListener("click", () => {
            setzeStatus("fehler", "Spracherkennung wird von diesem Browser nicht unterstützt. Bitte Chrome oder Edge verwenden.");
        });
    }
})();