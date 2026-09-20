# AI Accessibility Plugin (Sprachgesteuerter Web-Assistent)

Ein intelligentes, freihändiges Barrierefreiheits-Plugin zur Webnavigation und zum Ausfüllen von Formularen. Es macht mehrseitige Webanwendungen mithilfe von **lokalen LLMs (Ollama/Qwen2.5)**, **FastAPI** und der **Web Speech API** vollständig per Sprache steuerbar.

---

## Denkprozess & Entwicklungsverlauf

### 1. Grundidee & Problemstellung

Traditionelle Werkzeuge für digitale Barrierefreiheit (A11y) stützen sich häufig auf einfache Screenreader oder starre Tastatur-Shortcuts. Die Vision dieses Projekts war die Entwicklung einer **sprachgesteuerten Schnittstelle auf Basis natürlicher Sprache**, bei der Benutzer keine exakten Befehlsstrukturen auswendig lernen müssen (z. B. *"Klicke auf Button ID 3"*), sondern natürlich sprechen können (z. B. *"Ich muss mein Kind wegen Grippe krankmelden"*).

### 2. Architektur & Technische Vision

Um vollständige Privatsphäre und deterministische Steuerung zu gewährleisten, wurde die Architektur als dreistufige Pipeline konzipiert:

- **Frontend (`plugin.js`):** Ein leichtgewichtiges JavaScript-Widget, das in jede Webseite eingebunden werden kann. Es verarbeitet das Mikrofon-Audio über die Web Speech API und scannt das aktive DOM dynamisch nach interaktiven Elementen (Schaltflächen, Textfeldern, Checkboxen).
- **Backend (`main.py` mit FastAPI):** Eine schnelle Python-REST-API, die den DOM-Kontext und das Sprachskript des Benutzers empfängt.
- **Inference Engine (`Ollama` mit `qwen2.5:3b`):** Ein lokales LLM, das die Absicht des Benutzers analysiert und natürliche Sprache in eine strukturierte Abfolge deterministischer JSON-Browseraktionen umwandelt.

---

## Schritt-für-Schritt-Implementierung & Prototyping

### Schritt 1: Erstellung der Demo-Website mit Gemini

Um das Plugin unter realistischen Bedingungen zu testen, habe ich **Google Gemini als AI Pair Programmer** genutzt, um eine saubere Mehrseiten-Anwendung (MPA) mit typischen interaktiven Elementen (Formulare, Checkboxen, Navigationslinks) zu bauen:

- `index.html` (Dashboard / Schwarzes Brett)
- `essen.html` (Essensbuchung mit Checkboxen)
- `abmelden.html` (Abwesenheitsmeldung mit Textfeldern)

### Schritt 2: DOM-Scanning & Intent-Parsing

Eine zentrale technische Herausforderung war: **Woher weiß das LLM, welche Schaltflächen auf der Seite vorhanden sind?**

- **Lösung:** `plugin.js` scannt das sichtbare DOM vor dem Senden jeder Anfrage und erstellt eine leichtgewichtige Schnittstellenkarte. Diese Liste wird zusammen mit dem gesprochenen Text des Benutzers an das Python-Backend übermittelt.

### Schritt 3: Bewältigung von Neuladevorgängen bei Mehrseiten-Anwendungen (MPA)

In traditionellen MPAs führt das Anklicken eines Links zum vollständigen Entladen der aktuellen Seite. Dies führte zu zwei großen technischen Herausforderungen:

1. **Kontextverlust über Seitengrenzen hinweg:** Wenn ein Benutzer auf `index.html` sagt: *"Gehe zur Abwesenheitsmeldung und trage Grippe ein"*, kann das LLM das Eingabefeld auf der Zielseite noch nicht sehen.
  - *Lösung:* Implementierung eines **Warteschlangensystems via `sessionStorage`**. Wenn eine Seitennavigation erkannt wird, wird die ursprüngliche Sprachanfrage gespeichert. Beim Laden der neuen HTML-Seite wacht das Plugin automatisch auf, scannt das neue DOM und führt die verbleibende Befehlssequenz aus.
2. **Endlose Navigationsschleifen:**
  - *Herausforderung:* Nach dem Ankommen auf der Zielseite führte das LLM manchmal erneut einen Klick-Befehl für denselben Navigationslink aus.
  - *Lösung:* Einbau einer `window.location`-Prüfung in JavaScript, um Navigationsklicks zu überspringen, wenn sich der Browser bereits auf der Ziel-URL befindet.

### Schritt 4: Durchsetzung der Ausführungsreihenfolge & Async-Timing

Kleinere lokale LLMs liefern Aktionen gelegentlich nicht in chronologischer Reihenfolge zurück (z. B. der Versuch, auf "Absenden" zu klicken, bevor ein Kontrollkästchen aktiviert wurde).

- **Härtung des System-Prompts:** Überarbeitung des Python-System-Prompts zur strikten Durchsetzung chronologischer Logik (1. Navigation $\rightarrow$ 2. Formulareingaben/Checkboxen $\rightarrow$ 3. Formularabsendung).
- **Asynchrone Ausführungsverzögerungen:** Hinzufügen expliziter Ausführungsverzögerungen (`await warte(800)`) in `plugin.js`, um dem Browser-DOM ausreichend Zeit zu geben, Zustandsänderungen (wie `input`- oder `change`-Events) zu verarbeiten, bevor abschließende Submit-Klicks ausgelöst werden.

---

## Tech-Stack & Werkzeuge

- **Frontend:** Vanilla JavaScript (ES6+), Web Speech API, HTML5, CSS3
- **Backend:** Python 3.10+, FastAPI, Uvicorn (CORS aktiviert)
- **KI / Lokales LLM:** Ollama (`qwen2.5:3b`) lokal ausgeführt für die Absichtserkennung
- **AI Pair Programming:** Google Gemini (genutzt für das initiale HTML/CSS-Gerüst, Prompt Engineering und iteratives Refactoring)

---

## Installation & Einrichtung

### 1. Voraussetzungen

- Python 3.10 oder höher
- Lokal installierte und laufende Instanz von [Ollama](https://ollama.ai/) mit dem Modell:
  
  ```bash
  ollama run qwen2.5:3b
  ```
  

### 2. Repository klonen & Abhängigkeiten installieren

```bash
git clone https://github.com/AlexandraPushkin/ai-accessibility-plugin.git
```

```bash
cd ai-accessibility-plugin
```

```bash
pip install fastapi uvicorn requests
```

### 3. Backend-Server starten

```bash
python -m uvicorn main:app --reload
```

Der API-Server läuft unter http://127.0.0.1:8000

### 4. Anwendung testen

Öffnen Sie `index.html` in Ihrem Browser (oder über einen lokalen Webserver), klicken Sie auf die Mikrofon-Schaltfläche unten rechts und sprechen Sie einen Befehl wie zum Beispiel:

> "Ich möchte zur Krankmeldung navigieren und als Grund Grippe eingeben."