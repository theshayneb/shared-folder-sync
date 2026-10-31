/**
 * Shared Folder Sync mailbox.
 *
 * Paste this whole file into a new Google Apps Script project
 * (script.google.com), run `setup` once, then deploy it as a web app:
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * `setup` prints an owner code. Put it in the plugin's mailbox settings and
 * the plugin can create shares, each with its own share code. Every share
 * keeps its notes in its own JSON file in your Google Drive, and a share
 * code opens only that share.
 */

var SHARE_PREFIX = 'share:';
var MAX_PATH_LENGTH = 400;
var MAX_NAME_LENGTH = 100;

/** Run once from the editor. Prints the owner code to the execution log. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var owner = props.getProperty('OWNER_CODE');
  if (!owner) {
    owner = newCode_();
    props.setProperty('OWNER_CODE', owner);
  }
  migrateSingleShare_(props);
  Logger.log('Owner code: ' + owner);
  Logger.log('Put it in the plugin under Settings, Shared Folder Sync, Your mailbox.');
}

/** Run from the editor if the owner code leaks. Share codes keep working. */
function resetOwnerCode() {
  PropertiesService.getScriptProperties().deleteProperty('OWNER_CODE');
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
  if (!body || typeof body.key !== 'string') return json_({ ok: false, error: 'bad-share-code' });

  var props = PropertiesService.getScriptProperties();
  var owner = props.getProperty('OWNER_CODE');
  if (!owner) return json_({ ok: false, error: 'not-set-up' });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return json_({ ok: false, error: 'busy' });
  try {
    if (body.key === owner) return json_(handleOwner_(props, body));
    var share = readShare_(props, body.key);
    if (!share) return json_({ ok: false, error: 'bad-share-code' });
    if (body.action === 'ping') return json_({ ok: true, name: share.name });
    if (body.action !== 'sync') return json_({ ok: false, error: 'bad-request' });

    var file = DriveApp.getFileById(share.fileId);
    var state = parseState_(file.getBlob().getDataAsString());
    var result = handleSync_(state, body, body.ownerKey === owner);
    if (result.dirty) file.setContent(JSON.stringify(state));
    result.response.name = share.name;
    return json_(result.response);
  } catch (err) {
    return json_({ ok: false, error: 'server-error', detail: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** Actions only the owner code may run. */
function handleOwner_(props, body) {
  if (body.action === 'ping') return { ok: true, owner: true };

  if (body.action === 'create-share') {
    var name = cleanName_(body.name) || 'Shared folder';
    var code = newCode_();
    var file = DriveApp.createFile(
      'shared-folder-sync-' + name.replace(/[^\w -]/g, '') + '-' + code.slice(0, 6) + '.json',
      JSON.stringify({ rev: 0, files: {}, scope: null }),
      MimeType.PLAIN_TEXT
    );
    props.setProperty(SHARE_PREFIX + code, JSON.stringify({ name: name, fileId: file.getId(), created: Date.now() }));
    return { ok: true, code: code, name: name };
  }

  if (body.action === 'list-shares') {
    var all = props.getProperties();
    var shares = [];
    for (var key in all) {
      if (key.indexOf(SHARE_PREFIX) === 0) {
        var info = JSON.parse(all[key]);
        shares.push({ code: key.slice(SHARE_PREFIX.length), name: info.name, created: info.created });
      }
    }
    return { ok: true, shares: shares };
  }

  if (body.action === 'revoke-share') {
    var share = readShare_(props, body.code);
    if (!share) return { ok: false, error: 'bad-share-code' };
    props.deleteProperty(SHARE_PREFIX + body.code);
    try {
      DriveApp.getFileById(share.fileId).setTrashed(true);
    } catch (err) {
      // Already gone from Drive.
    }
    return { ok: true };
  }

  return { ok: false, error: 'bad-request' };
}

/**
 * Applies one client's pushed changes to `state` and returns everything that
 * changed after the client's cursor. Pure apart from mutating `state`.
 *
 * A change loses only when someone else changed the same file after the
 * client last saw it AND that other change is newer (by file mtime). The
 * loser gets the winning version back in `current`.
 *
 * When `canSetScope` is true (the request carried the owner code), the
 * request's `scope` becomes the share's folder and file list, which every
 * member's plugin adopts.
 */
function handleSync_(state, body, canSetScope) {
  var cursor = typeof body.cursor === 'number' ? body.cursor : 0;
  var changes = Array.isArray(body.changes) ? body.changes : [];
  var device = typeof body.device === 'string' ? body.device : '';
  var results = [];
  var dirty = false;

  if (canSetScope && body.scope) {
    var scope = cleanScope_(body.scope);
    if (scope && JSON.stringify(scope) !== JSON.stringify(state.scope || null)) {
      state.scope = scope;
      dirty = true;
    }
  }

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

  return {
    dirty: dirty,
    response: { ok: true, rev: state.rev, results: results, changes: out, scope: state.scope || null },
  };
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

function cleanScope_(scope) {
  var lists = [scope.folders, scope.files];
  for (var i = 0; i < lists.length; i++) {
    if (!Array.isArray(lists[i]) || lists[i].length > 200) return null;
    for (var j = 0; j < lists[i].length; j++) {
      if (!isSafePath_(lists[i][j])) return null;
    }
  }
  return { folders: scope.folders.slice(), files: scope.files.slice() };
}

function cleanName_(name) {
  return typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
}

function readShare_(props, code) {
  if (typeof code !== 'string' || code === '') return null;
  var raw = props.getProperty(SHARE_PREFIX + code);
  return raw ? JSON.parse(raw) : null;
}

/** Version 0.1.0 had one share code; keep it working as a share. */
function migrateSingleShare_(props) {
  var oldCode = props.getProperty('SHARE_CODE');
  var oldFile = props.getProperty('STORE_FILE_ID');
  if (oldCode && oldFile && !props.getProperty(SHARE_PREFIX + oldCode)) {
    props.setProperty(SHARE_PREFIX + oldCode, JSON.stringify({ name: 'Shared folder', fileId: oldFile, created: Date.now() }));
  }
  props.deleteProperty('SHARE_CODE');
  props.deleteProperty('STORE_FILE_ID');
}

function parseState_(text) {
  try {
    var parsed = JSON.parse(text);
    if (parsed && typeof parsed.rev === 'number' && parsed.files) return parsed;
  } catch (err) {
    // A damaged file starts empty.
  }
  return { rev: 0, files: {}, scope: null };
}

function newCode_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
