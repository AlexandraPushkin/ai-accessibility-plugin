# AI Accessibility Plugin (Voice-Controlled Web Assistant)

An intelligent, hands-free web navigation and form-filling accessibility plugin designed to make multi-page web applications fully voice-controllable using **Local LLMs (Ollama/Qwen2.5)**, **FastAPI**, and the **Web Speech API**.

---

## Thought Process & Development Journey

### 1. The Core Idea & Problem Statement
Traditional Web Accessibility (A11y) tools often rely on basic screen readers or rigid keyboard shortcuts. The vision for this project was to build a **natural language voice interface** where users don't need to memorize exact command structures (e.g., *"Click button ID 3"*), but can speak naturally (e.g., *"I need to report my child sick due to the flu"*).

### 2. Architecture & Technical Vision
To ensure total privacy and deterministic control, the architecture was designed as a three-tier pipeline:
* **Frontend (`plugin.js`):** A lightweight JavaScript widget injected into any web page. It handles microphone audio via the Web Speech API and dynamically scans the active DOM for interactive elements (buttons, text inputs, checkboxes).
* **Backend (`main.py` with FastAPI):** A fast Python REST API that receives the DOM context and the user's speech transcript.
* **Inference Engine (`Ollama` with `qwen2.5:3b`):** A local LLM that parses user intent and converts natural speech into a structured sequence of deterministic JSON browser actions.

---

## Step-by-Step Implementation & Prototyping

### Step 1: Generating the Demo Website with Gemini
To test the plugin under realistic conditions, I used **Google Gemini as an AI Pair Programmer** to build a clean Multi-Page Application (MPA) featuring typical interactive elements (forms, checkboxes, navigation links):
* `index.html` (Dashboard / Notice board)
* `essen.html` (Meal booking with checkboxes)
* `abmelden.html` (Absence reporting with text inputs)

### Step 2: DOM Scanning & Intent Parsing
A key technical challenge was: **How does the LLM know which buttons exist on the page?**
* **Solution:** `plugin.js` scans the visible DOM prior to sending each request and constructs a lightweight interface map. This list is sent alongside the user's spoken text to the Python backend.

### Step 3: Overcoming Multi-Page Application (MPA) Reloads
In traditional MPAs, clicking a link completely unloads the current page. This created two major engineering challenges:
1. **Cross-Page Context Loss:** If a user says on `index.html`: *"Go to absence reporting and enter flu"*, the LLM cannot see the text input on the destination page yet.
   * *Solution:* Implemented a **`sessionStorage` queue system**. When a page navigation is detected, the original voice query is persisted. Upon loading the new HTML page, the plugin automatically wakes up, scans the new DOM, and executes the remaining command sequence.
2. **Infinite Navigation Loops:**
   * *Challenge:* Once arrived on the target page, the LLM sometimes re-issued a click command for the same navigation link.
   * *Solution:* Built a `window.location` check in JavaScript to skip navigation clicks if the browser is already on the target URL.

### Step 4: Enforcing Execution Order & Async Timing
Smaller local LLMs occasionally return actions out of chronological order (e.g., attempting to click "Submit" before checking a box).
* **System Prompt Hardening:** Refined the Python system prompt to strictly enforce chronological reasoning (1. Navigation $\rightarrow$ 2. Form Inputs/Checkboxes $\rightarrow$ 3. Form Submission).
* **Asynchronous Execution Delays:** Added explicit execution delays (`await warte(800)`) in `plugin.js` to give the browser DOM enough time to process state changes (like `input` or `change` events) before triggering final submit clicks.

---

## Tech Stack & Tools

* **Frontend:** Vanilla JavaScript (ES6+), Web Speech API, HTML5, CSS3
* **Backend:** Python 3.10+, FastAPI, Uvicorn (CORS enabled)
* **AI / Local LLM:** Ollama (`qwen2.5:3b`) running locally for intent parsing
* **AI Pair Programming:** Google Gemini (used for initial HTML/CSS scaffolding, prompt engineering, and iterative refactoring)

---

## Installation & Setup

### 1. Prerequisites
* Python 3.10 or higher
* [Ollama](https://ollama.ai/) installed and running locally with the model:
  ```bash
  ollama run qwen2.5:3b
  ```

### 2. Clone Repository & Install Dependencies
  ```bash
  git clone https://github.com/AlexandraPushkin/ai-accessibility-plugin.git
  ```
  ```bash
  cd ai-accessibility-plugin
  ```
  ```bash
  pip install fastapi uvicorn requests
  ```

### 3. Start the Backend Server
```bash
python -m uvicorn main:app --reload
```
The API server will run at http://127.0.0.1:8000

### 4. Test the Application
Open index.html in your browser (or via a local web server), click the microphone button in the bottom right corner, and speak a command such as:

> "I want to navigate to absence reporting and enter flu as the reason."
