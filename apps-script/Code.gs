/**
 * Shared Folder Sync mailbox.
 *
 * Paste this whole file into a new Google Apps Script project
 * (script.google.com), run `setup` once, then deploy it as a web app:
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * The notes are kept in one JSON file in your Google Drive. Every request
 * must carry the share code that `setup` prints, so only people you give the
 * code to can read or change the list.
 */

var STORE_FILE_NAME = 'shared-folder-sync-store.json';
var MAX_PATH_LENGTH = 400;

/** Run once from the editor. Prints the share code to the execution log. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var code = props.getProperty('SHARE_CODE');
  if (!code) {
    code = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('SHARE_CODE', code);
  }
  var file = getStoreFile_();
  Logger.log('Share code: ' + code);
  Logger.log('Data file in your Drive: ' + file.getName());
}

/** Run from the editor if the share code leaks. Everyone must re-enter it. */
function resetShareCode() {
  PropertiesService.getScriptProperties().deleteProperty('SHARE_CODE');
  setup();
}

/** Opening the web app URL in a browser shows this, which confirms the deploy. */
function doGet() {
  return json_({ ok: true, service: 'shared-folder-sync' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad-request' });
  }

  var code = PropertiesService.getScriptProperties().getProperty('SHARE_CODE');
  if (!code) return json_({ ok: false, error: 'not-set-up' });
  if (!body || body.key !== code) return json_({ ok: false, error: 'bad-share-code' });
  if (body.action === 'ping') return json_({ ok: true });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return json_({ ok: false, error: 'busy' });
  try {
    var file = getStoreFile_();
    var state = parseState_(file.getBlob().getDataAsString());
    var result = handleSync_(state, body);
    if (result.dirty) file.setContent(JSON.stringify(state));
    return json_(result.response);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Applies one client's pushed changes to `state` and returns everything that
 * changed after the client's cursor. Pure apart from mutating `state`.
 *
 * A change loses only when someone else changed the same file after the
 * client last saw it AND that other change is newer (by file mtime). The
 * loser gets the winning version back in `current`.
 */
function handleSync_(state, body) {
  var cursor = typeof body.cursor === 'number' ? body.cursor : 0;
  var changes = Array.isArray(body.changes) ? body.changes : [];
  var device = typeof body.device === 'string' ? body.device : '';
  var results = [];
  var dirty = false;

  for (var i = 0; i < changes.length; i++) {
    var change = changes[i];
    if (!change || !isSafePath_(change.path)) continue;
    var content = typeof change.content === 'string' ? change.content : null;
    var baseRev = typeof change.baseRev === 'number' ? change.baseRev : 0;
    var mtime = typeof change.mtime === 'number' ? change.mtime : 0;
    var existing = state.files[change.path];

    if (!existing && content === null) {
      results.push({ path: change.path, status: 'accepted', rev: 0 });
      continue;
    }
    if (existing && existing.content === content) {
      results.push({ path: change.path, status: 'accepted', rev: existing.rev });
      continue;
    }
    if (existing && existing.rev > baseRev && existing.mtime > mtime) {
      results.push({ path: change.path, status: 'rejected', rev: existing.rev, current: toEntry_(change.path, existing) });
      continue;
    }

    state.rev += 1;
    state.files[change.path] = { rev: state.rev, content: content, mtime: mtime, by: device };
    results.push({ path: change.path, status: 'accepted', rev: state.rev });
    dirty = true;
  }

  var out = [];
  for (var path in state.files) {
    if (Object.prototype.hasOwnProperty.call(state.files, path) && state.files[path].rev > cursor) {
      out.push(toEntry_(path, state.files[path]));
    }
  }
  out.sort(function (a, b) { return a.rev - b.rev; });

  return { dirty: dirty, response: { ok: true, rev: state.rev, results: results, changes: out } };
}

function toEntry_(path, f) {
  return { path: path, rev: f.rev, content: f.content, deleted: f.content === null, mtime: f.mtime };
}

function isSafePath_(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (path.charAt(0) === '/' || path.indexOf('\\') !== -1) return false;
  var parts = path.split('/');
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '' || parts[i] === '.' || parts[i] === '..') return false;
  }
  // Hidden top-level folders hold Obsidian's own settings.
  return parts[0].charAt(0) !== '.';
}

function parseState_(text) {
  try {
    var parsed = JSON.parse(text);
    if (parsed && typeof parsed.rev === 'number' && parsed.files) return parsed;
  } catch (err) {
    // A new or damaged file starts empty.
  }
  return { rev: 0, files: {} };
}

function getStoreFile_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('STORE_FILE_ID');
  if (id) {
    try {
      return DriveApp.getFileById(id);
    } catch (err) {
      // Deleted from Drive; make a new one below.
    }
  }
  var file = DriveApp.createFile(STORE_FILE_NAME, JSON.stringify({ rev: 0, files: {} }), MimeType.PLAIN_TEXT);
  props.setProperty('STORE_FILE_ID', file.getId());
  return file;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
