/*** ===== CONFIG ===== */
const SHEET_NAME = 'Sheet1'; // change to your sheet/tab name
const SPREADSHEET_ID = ''; // leave blank to use the container-bound sheet

// Column order must match your header row exactly:
const COLUMNS = [
  'ID', 'Title', 'Type', 'Current Chapter', 'Latest Chapter',
  'Status', 'URL', 'Cover Image URL', 'Notes'
];

function getSheet_() {
  const ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`Sheet named "${SHEET_NAME}" not found.`);
  return sheet;
}

/**
 * ===== 1. doGet() — Optimized JSON API =====
 */
function doGet(e) {
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const rows = data.slice(1);

    // OPTIMIZATION: Exclude heavy or unnecessary columns from the frontend payload
    const EXCLUDE_COLS = ['Notes']; 

    const json = rows
      .filter(row => row.some(cell => cell !== '')) // skip fully blank rows
      .map(row => {
        const obj = {};
        headers.forEach((header, i) => {
          if (!EXCLUDE_COLS.includes(header)) {
            obj[header] = row[i];
          }
        });
        return obj;
      });

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, count: json.length, data: json }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * ===== 2. fetchLatestChapters() — the scraping automation =====
 * Run manually or attach a time-driven trigger.
 *
 * Writes are batched: instead of calling setValue() once per updated
 * row (N sheet API calls), this builds the full "Latest Chapter" and
 * "Last Updated" columns in memory and writes each back in a single
 * setValues() call at the end. Keeps the run well under the 6-minute
 * Apps Script execution limit as the library grows.
 */
function fetchLatestChapters() {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const colIndex = {};
  COLUMNS.forEach(name => {
    const idx = headers.indexOf(name);
    if (idx === -1) throw new Error(`Missing expected column: ${name}`);
    colIndex[name] = idx;
  });

  // Optional column — script still works fine if you haven't added it yet
  const lastUpdatedCol = headers.indexOf('Last Updated');

  const urlCol = colIndex['URL'];
  const latestCol = colIndex['Latest Chapter'];
  const titleCol = colIndex['Title'];

  const log = [];

  // In-memory copies of the columns we might change, so all sheet
  // writes can be batched into (at most) two setValues() calls at the
  // end instead of one write per manga.
  const latestColValues = data.map(row => [row[latestCol]]);
  const lastUpdatedColValues = lastUpdatedCol !== -1
    ? data.map(row => [row[lastUpdatedCol]])
    : null;
  let hasChanges = false;

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const url = row[urlCol];
    const title = row[titleCol] || `Row ${r + 1}`;

    if (!url) continue;

    try {
      const html = fetchPage_(url);
      const foundChapter = extractLatestChapter_(html);

      if (foundChapter === null) {
        log.push(`⚠️ ${title}: no chapter number found`);
        continue;
      }

      const currentLatest = parseFloat(row[latestCol]) || 0;

      if (foundChapter > currentLatest) {
        latestColValues[r][0] = foundChapter;
        hasChanges = true;

        // Stamp "Last Updated" only when a genuinely new chapter appears
        if (lastUpdatedColValues) {
          lastUpdatedColValues[r][0] = new Date();
        }

        log.push(`✅ ${title}: updated ${currentLatest} → ${foundChapter}`);
      } else {
        log.push(`— ${title}: no change (latest known ${currentLatest}, found ${foundChapter})`);
      }

      Utilities.sleep(800); // Respect rate limits

    } catch (err) {
      log.push(`❌ ${title}: fetch/parse error — ${err.message}`);
    }
  }

  // Single batched write per column instead of one write per updated row
  if (hasChanges) {
    sheet.getRange(1, latestCol + 1, latestColValues.length, 1).setValues(latestColValues);
    if (lastUpdatedColValues) {
      sheet.getRange(1, lastUpdatedCol + 1, lastUpdatedColValues.length, 1).setValues(lastUpdatedColValues);
    }
  }

  Logger.log(log.join('\n'));
  return log;
}

/**
 * Fetch page HTML with a normal browser-like User-Agent
 * and muteHttpExceptions so one bad site doesn't kill the run.
 */
function fetchPage_(url) {
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    }
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`HTTP ${code}`);
  }
  return response.getContentText();
}

/**
 * Terms different manga sites/series use instead of "Chapter".
 * Add more as you discover them.
 */
const CHAPTER_TERMS = [
  'chapter', 'ch', 'episode', 'ep', 'mission', 'session',
  'act', 'issue', 'volume', 'vol', 'file', 'days', 'hunt',
  'brush'
];

function extractLatestChapter_(html, customTerm) {
  // Layer 1: strip out comments section before any scanning
  const commentMarkers = [/id=["']comments["']/i, /wpd-comm-/i, /wpDiscuz/i];
  let trimmedHtml = html;
  for (const marker of commentMarkers) {
    const m = trimmedHtml.match(marker);
    if (m && m.index !== undefined) {
      trimmedHtml = trimmedHtml.substring(0, m.index);
      break;
    }
  }

  // Layer 2 (highest priority): explicit "Latest: Chapter 99" label,
  const latestLabelRegex = /Latest[\s\S]{0,60}?(?:chapter|ch\.?|ep(?:isode)?|mission|act)\.?\s*(\d+(?:\.\d+)?)/i;
  const latestLabelMatch = trimmedHtml.match(latestLabelRegex);
  if (latestLabelMatch) {
    return parseFloat(latestLabelMatch[1]);
  }

  // Layer 3: dedicated "New Chapter" badge/link (WordPress/Madara style)
  const newChapterRegex = /href=["']([^"']*-chapter-(\d+(?:\.\d+)?)\/?)["'][^>]*>[\s\S]{0,80}?New\s*Chapter/i;
  const newChapterMatch = trimmedHtml.match(newChapterRegex);
  if (newChapterMatch) {
    return parseFloat(newChapterMatch[2]);
  }

  // Layer 4: href-based chapter slug extraction (max of all chapter links)
  const candidates = [];
  const hrefChapterMatches = trimmedHtml.match(/href=["'][^"']*-chapter-(\d+(?:\.\d+)?)\/?["']/gi) || [];
  hrefChapterMatches.forEach(m => {
    const num = m.match(/-chapter-(\d+(?:\.\d+)?)/i);
    if (num) candidates.push(parseFloat(num[1]));
  });
  
  const hrefChapterPathMatches = trimmedHtml.match(/href=["'][^"']*\/chapter\/(\d+(?:\.\d+)?)\/?["']/gi) || [];
  hrefChapterPathMatches.forEach(m => {
    const num = m.match(/\/chapter\/(\d+(?:\.\d+)?)/i);
    if (num) candidates.push(parseFloat(num[1]));
  });

  if (candidates.length > 0) {
    const plausible = candidates.filter(n => n > 0 && n < 5000);
    if (plausible.length > 0) return Math.max(...plausible);
  }

  // Layer 5 (fallback): term-based scanning for sites without any of the above patterns
  const terms = customTerm ? [customTerm.toLowerCase()] : CHAPTER_TERMS;
  const termPattern = terms.map(t => escapeRegex_(t)).join('|');

  const ldJsonMatches = trimmedHtml.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  ldJsonMatches.forEach(block => {
    const nums = block.match(/"chapterNumber"\s*:\s*"?(\d+(?:\.\d+)?)"?/gi) || [];
    nums.forEach(n => {
      const m = n.match(/(\d+(?:\.\d+)?)/);
      if (m) candidates.push(parseFloat(m[1]));
    });
  });

  const slugRegex = new RegExp(`(?:${termPattern})[-_\\s]?(\\d+(?:\\.\\d+)?)`, 'gi');
  const slugMatches = trimmedHtml.match(slugRegex) || [];
  slugMatches.forEach(m => {
    const num = m.match(/(\d+(?:\.\d+)?)/);
    if (num) candidates.push(parseFloat(num[1]));
  });

  const classRegex = new RegExp(`class=["'][^"']*(?:${termPattern})[^"']*["'][^>]*>([\\s\\S]{0,120}?)<`, 'gi');
  const classBlockMatches = trimmedHtml.match(classRegex) || [];
  classBlockMatches.forEach(block => {
    const m = block.match(/(\d+(?:\.\d+)?)/);
    if (m) candidates.push(parseFloat(m[1]));
  });

  const textRegex = new RegExp(`\\b(?:${termPattern})\\.?\\s*(\\d+(?:\\.\\d+)?)\\b`, 'gi');
  const textMatches = trimmedHtml.match(textRegex) || [];
  textMatches.forEach(m => {
    const num = m.match(/(\d+(?:\.\d+)?)/);
    if (num) candidates.push(parseFloat(num[1]));
  });

  if (candidates.length === 0) return null;
  const plausible = candidates.filter(n => n > 0 && n < 5000);
  if (plausible.length === 0) return null;
  return Math.max(...plausible);
}

function escapeRegex_(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Optional: create a time-driven trigger to run fetchLatestChapters()
 */
function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'fetchLatestChapters') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('fetchLatestChapters')
    .timeBased()
    .everyHours(6)
    .create();
}

/**
 * ===== 4. Auto-fill on paste — installable onEdit trigger =====
 */
function handleEdit(e) {
  try {
    const sheet = e.range.getSheet();
    if (sheet.getName() !== SHEET_NAME) return;

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const urlColIndex = headers.indexOf('URL') + 1; // 1-based
    if (urlColIndex === 0) return;

    const editedRange = e.range;
    const editedFirstCol = editedRange.getColumn();
    const editedLastCol = editedFirstCol + editedRange.getNumColumns() - 1;

    if (urlColIndex < editedFirstCol || urlColIndex > editedLastCol) return;

    const startRow = editedRange.getRow();
    const numRows = editedRange.getNumRows();

    for (let i = 0; i < numRows; i++) {
      const row = startRow + i;
      if (row === 1) continue; // skip header row

      const url = sheet.getRange(row, urlColIndex).getValue();
      if (url) populateRowFromUrl_(sheet, headers, row, url);
    }
  } catch (err) {
    Logger.log('handleEdit error: ' + err.message);
  }
}

function populateRowFromUrl_(sheet, headers, row, url) {
  const colIndex = {};
  headers.forEach((h, i) => colIndex[h] = i + 1); // 1-based columns

  const titleCell = sheet.getRange(row, colIndex['Title']);
  if (titleCell.getValue()) return;

  try {
    const html = fetchPage_(url);
    const meta = extractMangaMetadata_(html);
    const latestChapter = extractLatestChapter_(html) || 0;

    const idCell = sheet.getRange(row, colIndex['ID']);
    if (!idCell.getValue()) {
      const lastRow = sheet.getLastRow();
      const existingIds = lastRow > 1
        ? sheet.getRange(2, colIndex['ID'], lastRow - 1, 1).getValues().map(r => parseFloat(r[0]) || 0)
        : [];
      const newId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
      idCell.setValue(newId);
    }

    titleCell.setValue(meta.title || 'Unknown Title');
    sheet.getRange(row, colIndex['Type']).setValue(meta.type || '');
    sheet.getRange(row, colIndex['Current Chapter']).setValue(0);
    sheet.getRange(row, colIndex['Latest Chapter']).setValue(latestChapter);
    sheet.getRange(row, colIndex['Status']).setValue(meta.status || '');
    sheet.getRange(row, colIndex['Cover Image URL']).setValue(meta.coverImage || '');

  } catch (err) {
    sheet.getRange(row, colIndex['Notes']).setValue('⚠️ Auto-fill failed: ' + err.message);
  }
}

/**
 * Pulls Title, Type, Status, Cover Image from a manga page.
 */
function extractMangaMetadata_(html) {
  const meta = {};

  let m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) {
    meta.title = decodeHtmlEntities_(m[1].replace(/<[^>]+>/g, '').trim());
  } else {
    m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (m) meta.title = decodeHtmlEntities_(m[1]);
  }

  if (meta.title) meta.title = cleanMangaTitle_(meta.title);

  meta.coverImage = extractCoverImage_(html);

  m = html.match(/Type[\s\S]{0,60}?<[^>]+>\s*([A-Za-z]+)\s*<\/[^>]+>/i)
    || html.match(/Type\s*[:\-]?\s*<[^>]*>\s*([A-Za-z]+)/i);
  if (m) meta.type = m[1].trim();

  m = html.match(/Status[\s\S]{0,60}?<[^>]+>\s*([A-Za-z]+)\s*<\/[^>]+>/i)
    || html.match(/Status\s*[:\-]?\s*<[^>]*>\s*([A-Za-z]+)/i);
  if (m) meta.status = m[1].trim();

  return meta;
}

function cleanMangaTitle_(title) {
  let clean = title;
  clean = clean.replace(/^Read\s+/i, '');
  clean = clean.replace(/\s*\|\s*[^|]+$/, '');
  clean = clean.replace(/\s+[-–]\s+[^-–]+$/, '');
  clean = clean.replace(/\s*[\[\(][^\]\)]*(?:latest|chapter|official|read|online)[^\]\)]*[\]\)]\s*/gi, ' ');
  clean = clean.replace(/\s+(?:Manga|Manhwa|Manhua)\s*$/i, '');
  return clean.replace(/\s{2,}/g, ' ').trim();
}

function extractCoverImage_(html) {
  let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (m) return m[1];

  m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (m) return m[1];

  m = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  if (m) return m[1];

  m = html.match(/<[^>]+itemprop=["']image["'][^>]+(?:src|content)=["']([^"']+)["']/i);
  if (m) return m[1];

  const itemPropIdx = html.search(/<[^>]+itemprop=["']image["']/i);
  if (itemPropIdx !== -1) {
    const nearbyHtml = html.substring(itemPropIdx, itemPropIdx + 500);
    const imgMatch = nearbyHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch) return imgMatch[1];
  }

  m = html.match(/<img[^>]*(?:class=["'][^"']*(?:cover|thumb)[^"']*["'][^>]*src|src=["'][^"']*(?:cover|thumb)[^"']*["'])[^>]*>/i);
  if (m) {
    const srcMatch = m[0].match(/src=["']([^"']+)["']/i);
    if (srcMatch) return srcMatch[1];
  }

  return '';
}

function decodeHtmlEntities_(str) {
  return str
    .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(code))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function createEditTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'handleEdit') ScriptApp.deleteTrigger(t);
  });

  const ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();

  ScriptApp.newTrigger('handleEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();
}

/**
 * ===== 5. doPost() =====
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    if (payload.action === 'addManga') {
      const result = addMangaFromUrl_(payload.url);
      return jsonResponse_({ success: true, data: result });
    }

    if (payload.action === 'updateProgress') {
      const result = updateCurrentChapter_(payload.id, payload.currentChapter, payload.delta);
      return jsonResponse_({ success: true, data: result });
    }

    if (payload.action === 'updateStatus') {
      const result = updateMangaStatus_(payload.id, payload.status);
      return jsonResponse_({ success: true, data: result });
    }

    if (payload.action === 'updateUrl') {
      const result = updateMangaUrl_(payload.id, payload.url);
      return jsonResponse_({ success: true, data: result });
    }

    if (payload.action === 'deleteManga') {
      const result = deleteManga_(payload.id);
      return jsonResponse_({ success: true, data: result });
    }
    return jsonResponse_({ success: false, error: 'Unknown action' });

  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function updateCurrentChapter_(id, currentChapter, delta) {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const idCol = headers.indexOf('ID');
  const currentCol = headers.indexOf('Current Chapter');
  const latestCol = headers.indexOf('Latest Chapter');

  let targetRow = -1;
  for (let r = 1; r < data.length; r++) {
    if (Number(data[r][idCol]) === Number(id)) {
      targetRow = r;
      break;
    }
  }

  if (targetRow === -1) throw new Error(`No manga found with ID ${id}`);

  const latestChapter = parseFloat(data[targetRow][latestCol]) || 0;
  const existingCurrent = parseFloat(data[targetRow][currentCol]) || 0;

  let newValue;
  if (typeof currentChapter === 'number') {
    newValue = currentChapter;
  } else if (typeof delta === 'number') {
    newValue = existingCurrent + delta;
  } else {
    throw new Error('Must provide either currentChapter or delta');
  }

  newValue = Math.max(0, Math.min(newValue, latestChapter));
  sheet.getRange(targetRow + 1, currentCol + 1).setValue(newValue);

  return {
    id: id,
    currentChapter: newValue,
    latestChapter: latestChapter
  };
}

function updateMangaStatus_(id, status) {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('ID');
  const statusCol = headers.indexOf('Status');

  for (let r = 1; r < data.length; r++) {
    if (Number(data[r][idCol]) === Number(id)) {
      sheet.getRange(r + 1, statusCol + 1).setValue(status);
      return { id: id, status: status };
    }
  }
  throw new Error(`No manga found with ID ${id}`);
}

function updateMangaUrl_(id, url) {
  if (!url || !url.trim()) throw new Error('URL cannot be empty');
  const cleanUrl = url.trim();

  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('ID');
  const urlCol = headers.indexOf('URL');
  const titleCol = headers.indexOf('Title');
  const typeCol = headers.indexOf('Type');
  const coverCol = headers.indexOf('Cover Image URL');
  const latestCol = headers.indexOf('Latest Chapter');

  let targetRow = -1;
  for (let r = 1; r < data.length; r++) {
    if (Number(data[r][idCol]) === Number(id)) { targetRow = r; break; }
  }
  if (targetRow === -1) throw new Error(`No manga found with ID ${id}`);

  sheet.getRange(targetRow + 1, urlCol + 1).setValue(cleanUrl);

  const result = { id: id, url: cleanUrl };

  try {
    const html = fetchPage_(cleanUrl);
    const meta = extractMangaMetadata_(html);
    const latestChapter = extractLatestChapter_(html) || 0;

    if (meta.title) sheet.getRange(targetRow + 1, titleCol + 1).setValue(meta.title);
    if (meta.type) sheet.getRange(targetRow + 1, typeCol + 1).setValue(meta.type);
    if (meta.coverImage) sheet.getRange(targetRow + 1, coverCol + 1).setValue(meta.coverImage);
    sheet.getRange(targetRow + 1, latestCol + 1).setValue(latestChapter);

    result.title = meta.title;
    result.type = meta.type;
    result.coverImage = meta.coverImage;
    result.latestChapter = latestChapter;
    result.metadataRefreshed = true;
  } catch (err) {
    result.metadataRefreshed = false;
    result.metadataError = err.message;
  }

  return result;
}

function deleteManga_(id) {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('ID');

  for (let r = 1; r < data.length; r++) {
    if (Number(data[r][idCol]) === Number(id)) {
      sheet.deleteRow(r + 1);
      return { id: id, deleted: true };
    }
  }
  throw new Error(`No manga found with ID ${id}`);
}

function fixLastUpdatedFormat() {
  const sheet = getSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIdx = headers.indexOf('Last Updated');

  if (colIdx === -1) {
    Logger.log('Last Updated column not found.');
    return;
  }

  const lastRow = sheet.getMaxRows();
  const range = sheet.getRange(1, colIdx + 1, lastRow, 1);
  range.setNumberFormat('yyyy-mm-dd hh:mm:ss'); 
  Logger.log(`Formatted column ${colIdx + 1} ("Last Updated") for all rows.`);
}

function addMangaFromUrl_(url) {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const colIndex = {};
  COLUMNS.forEach(name => colIndex[name] = headers.indexOf(name));

  const html = fetchPage_(url);
  const meta = extractMangaMetadata_(html);
  const latestChapter = extractLatestChapter_(html) || 0;

  const idCol = colIndex['ID'];
  const existingIds = data.slice(1).map(r => parseFloat(r[idCol]) || 0);
  const newId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;

  const newRow = [];
  newRow[colIndex['ID']] = newId;
  newRow[colIndex['Title']] = meta.title || 'Unknown Title';
  newRow[colIndex['Type']] = meta.type || '';
  newRow[colIndex['Current Chapter']] = 0;
  newRow[colIndex['Latest Chapter']] = latestChapter;
  newRow[colIndex['Status']] = meta.status || '';
  newRow[colIndex['URL']] = url;
  newRow[colIndex['Cover Image URL']] = meta.coverImage || '';
  newRow[colIndex['Notes']] = '';

  sheet.appendRow(newRow);

  return {
    id: newId,
    title: meta.title,
    type: meta.type,
    status: meta.status,
    latestChapter: latestChapter,
    coverImage: meta.coverImage
  };
}