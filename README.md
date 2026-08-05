# MangaTracker
A personal tracker/bookmark of all the Manga, Manhwa, and Manhua that I currently read, use Google Sheets as a database via Google Apps Script. I hate creating an account.

## 🚀 Features
* **Custom Database:** Uses your personal Google Sheets as a backend.
* **Serverless Hosting:** Runs entirely in the browser via GitHub Pages.
* **Secure Setup:** Connects via a Google Apps Script Web App URL stored locally in your browser—no hardcoded API keys.

## 🛠️ How to Setup Your Own Tracker
If you want to copy this project and use it for your own manga collection, follow these setup steps:

### 1. Create the Google Sheet
Create a brand new Google Sheet and set up the header row (Row 1) with these **exact column names** in this specific order:

| Column | Header Name | Description |
| :---: | :--- | :--- |
| **A** | `ID` | Unique identifier or row number |
| **B** | `Title` | The name of the manga |
| **C** | `Type` | Format (e.g., Manga, Manhwa, Manhua) |
| **D** | `Current Chapter` | The last chapter you read |
| **E** | `Latest Chapter` | The total or most recently released chapter |
| **F** | `Status` | Current reading state (e.g., Reading, Plan to Read, Completed) |
| **G** | `URL` | Link to read or view details (e.g., MyAnimeList or MangaDex) |
| **H** | `Cover Image URL` | Direct image link (`.jpg`/`.png`) for the cover display |
| **I** | `Notes` | Personal thoughts or quick reminders |
| **J** | `Last Updated` | Timestamp of your latest update |

---

### 2. Deploy the Google Apps Script
To let the website communicate safely with your spreadsheet:
1. Inside your new Google Sheet, go to the top menu and click **Extensions** > **Apps Script**.
2. Delete any existing code in the editor.
3. Copy and Paste the code in code.gs file
4. Click the **Save** disk icon.
5. Click **Deploy** (top right corner) > Select **New deployment**.
6. Click the gear icon next to "Select type" and choose **Web app**.
7. Set the configuration details exactly as follows:
   * **Execute as:** `Me (your-email@gmail.com)`
   * **Who has access:** `Anyone` *(Required so your browser can make requests to it)*
8. Click **Deploy** and complete the Google account authorization prompts.
9. Copy the generated **Web App URL** (it will end with `/exec`).

---

### 3. Configure Automated Triggers
This project uses background triggers to automatically update manga data (like timestamps or fetching the latest chapters). To set them up:

1. In your Apps Script editor sidebar, click the **Triggers** icon (the alarm clock ⏰ icon).
2. Click the blue **+ Add Trigger** button in the bottom right corner.
3. Add the **On Edit** trigger:
   * **Choose which function to run:** `handleEdit`
   * **Choose which deployment should run:** `Head`
   * **Select event source:** `From spreadsheet`
   * **Select event type:** `On edit`
   * Click **Save**.
4. Add the **Time-Based** trigger:
   * **Choose which function to run:** `fetchLatestChapters`
   * **Choose which deployment should run:** `Head`
   * **Select event source:** `Time-driven`
   * **Select type of time based trigger:** `Hour timer` (and select your preferred interval)
   * Click **Save**.

### 4. Connect to the App
1. Open the live hosted URL of this website.
2. Click on the **Settings** icon/button in the user interface.
3. Paste your copied Google Apps Script **Web App URL** into the input field.
4. Save and reload the page. Your tracker is now fully operational!


# Manga Tracker Extension (Browser Extension) — How to Use

A quick guide to installing and using the extension.

## 1. Install the extension

1. Unzip the extension folder somewhere on your computer (keep it — Chrome loads it from this location, so don't delete it after installing).
2. Open `chrome://extensions` (or `edge://extensions` if you're on Edge).
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select the unzipped `manga-badge-extension` folder.
6. The extension's icon (📚) should now appear in your toolbar. If you don't see it, click the puzzle-piece icon in the toolbar and pin it.

## 2. Connect it to your Manga Tracker

The extension needs the same Web App URL your Manga Tracker app uses.

1. Open your Manga Tracker's Apps Script project.
2. Go to **Deploy → Manage deployments**.
3. Copy the **Web app URL** next to your active deployment — it should end in `/exec`.
4. Double-check **"Who has access"** is set to **Anyone** (not "Anyone with Google account") — otherwise the extension can't reach it.
5. Click the extension's toolbar icon, then **Settings** (bottom-right of the popup).
6. Paste the URL into the field and click **Save & Refresh**.

That's it — the popup should immediately load your library's counts.
