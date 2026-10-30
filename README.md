# Shared Folder Sync

Share one folder of your vault, plus single files such as a Base, with
another person's Obsidian vault. Both of you can add, edit and delete notes,
and the changes reach the other vault within seconds.

Changes travel through a small Google Apps Script "mailbox" that you deploy
under your own Google account. It stores the shared notes in one file in your
Google Drive. The other person only needs the plugin and an invite. They
don't need a Google login, and nothing else in either vault is sent.

Works on desktop, Android and iPhone.

## How it behaves

- **What's shared:** `.md`, `.base`, `.canvas` and `.txt` files inside the
  shared folders, plus any single files you list. Images and other
  attachments are not shared.
- **When it syncs:** a few seconds after you edit a shared file, every 30
  seconds while Obsidian is open (you can change this), and when you switch
  back to Obsidian on a phone.
- **Same paths in both vaults:** files land at the same paths in the other
  vault, for example `Reference/Grocery Items/Milk.md`. Folders are created
  if they're missing.
- **Both editing the same note:** the later edit wins and the earlier one
  is replaced. Edits to different notes never conflict.
- **Deletes:** deleting a shared note deletes it for the other person too. It
  goes to Obsidian's trash on their side, so it can be recovered.

## Setup, part 1: the mailbox (owner, once)

1. Go to [script.google.com](https://script.google.com) and click
   **New project**. Name it something like *Grocery mailbox*.
2. Delete the sample code in `Code.gs` and paste in all of
   [`apps-script/Code.gs`](apps-script/Code.gs). Click **Save**.
3. In the function menu at the top, pick **setup** and click **Run**. Google
   asks for permission to use your Drive. Because this is your own script,
   Google shows an "unverified app" screen: click **Advanced**, then
   **Go to Grocery mailbox**, then **Allow**.
4. Open **Execution log** and copy the **Share code** it printed.
5. Click **Deploy → New deployment**. Click the gear and pick **Web app**.
   Set **Execute as: Me** and **Who has access: Anyone**, then click
   **Deploy**. Copy the **Web app URL** (it ends in `/exec`).
6. Optional check: open the URL in a browser. It should show
   `{"ok":true,"service":"shared-folder-sync"}`.

"Anyone" means anyone with the URL can reach the script, but the script
refuses every request that doesn't carry the share code. To change the code,
run `resetShareCode` from the editor and send a new invite.

## Setup, part 2: your vault

1. Install the plugin through [BRAT](https://github.com/TfTHacker/obsidian42-brat)
   (**Add beta plugin** with `theshayneb/shared-obs-folder`) and enable it.
2. Open **Settings → Shared Folder Sync** and fill in:
   - **Web app URL** and **Share code** from part 1. Click **Test**.
   - **Folders**: `Reference/Grocery Items`
   - **Single files**: `Utilities/Bases/ShoppingList.base`
3. Click **Sync now**. The first sync uploads every shared note.
4. Click **Copy invite** and send the invite to the other person through a
   private channel, such as a direct message. Anyone with the invite can edit
   the shared notes.

## Setup, part 3: the other person's vault

1. Install BRAT and this plugin the same way, and enable it.
2. Open **Settings → Shared Folder Sync**, paste the invite into
   **Join with an invite** and click **Join**.

The shared folder and Base appear at the same paths as in your vault.

## Tips for a grocery list

- Show `In_Stock` as a column in the Base's table view. Its checkbox can be
  ticked right in the table, and the tick syncs like any other edit.
- To add an item, create a note in `Reference/Grocery Items` with the usual
  properties. A template with `Type`, `Location`, `In_Stock: false` and the
  `grocery` tag makes this quick.
- The command palette has **Sync now** and **Copy invite for the other
  person**, and there's a sync button in the ribbon.

## Updating the mailbox script

If `Code.gs` changes in a later version, paste the new code, then use
**Deploy → Manage deployments → Edit (pencil) → Version: New version →
Deploy**. That keeps the same URL, so nobody needs a new invite.

## Limits

- Changes arrive within seconds. Edits don't appear live, keystroke by
  keystroke, the way a shared Google Doc does.
- Google limits how much Apps Script can run each day on a free account. A
  few devices checking every 30 seconds stays well within that. If syncs
  start failing late in the day, raise the interval in settings.
- Deleted notes are remembered in the mailbox as tombstones. For a grocery
  list the mailbox file stays small.

## Development

```bash
npm ci
```

```bash
npm test
```

```bash
npm run build
```

Tests run the real `apps-script/Code.gs` against in-memory stand-ins for
Google's services, with two simulated vaults syncing through it.

To release, bump `version` in `manifest.json`, `package.json` and
`versions.json`, commit, and push a tag equal to the version
(`git tag 0.1.1 && git push origin 0.1.1`). The release workflow publishes
`main.js` and `manifest.json`, which BRAT installs.
