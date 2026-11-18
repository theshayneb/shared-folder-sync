# Shared Folder Sync

Share folders of your vault, plus single files such as a Base, with other
people's Obsidian vaults. Everyone in a share can add, edit and delete its
notes, and the changes reach the other vaults within a minute or two.

You can make as many **shares** as you like. Each share has its own folders,
files and share code, so you can share your grocery list with your roommate
and a different folder with someone else. A share code opens only its own
share.

Changes travel through a small Google Apps Script "mailbox" that you deploy
under your own Google account. Each share's notes are kept in their own file
in your Google Drive. The people you share with only need the plugin and an
invite. They don't need a Google login, and nothing outside the share is
sent.

Works on desktop, Android and iPhone.

## How it behaves

- **What's shared:** `.md`, `.base`, `.canvas` and `.txt` files inside the
  shared folders, plus any single files you list. Images and other
  attachments are not shared.
- **Same paths in every vault:** files land at the same paths in the other
  vaults, for example `Reference/Grocery Items/Milk.md`. Folders are created
  if they're missing.
- **Both editing the same note:** the edits are merged. In a note's
  properties, each property merges on its own, so one person ticking
  `In_Stock` and another changing `Location` both survive. The note's text
  merges line by line. Only when both change the same property or line does
  one edit win: the one with the newer file modified time.
- **Deletes:** deleting a shared note deletes it for everyone in the share. It
  goes to Obsidian's trash on their side, so it can be recovered. If one
  person deletes a note while another edits it, the edit wins.
- **Conflict copies:** if Obsidian Sync makes a `(Conflicted copy …)` file
  inside a shared folder, it stays in your vault and isn't shared.

## Your devices: one always-on device does the syncing

If you use Obsidian Sync across several devices, only **one** of them should
talk to the mailbox: the one that's on the most, usually a desktop. Your other
devices get shared notes from it through Obsidian Sync, and their edits reach
it the same way.

This is the **Run background tasks on this device** switch at the top of the
plugin's settings. It's saved on each device separately and is never synced.
It starts **on** for desktops and **off** for phones and tablets. A phone or
tablet where Obsidian Sync is off starts with it on, since nothing else would
bring changes there.

With background tasks on, the device:

- checks the mailbox every 30 seconds (you can change this);
- sends your edits shortly after you make them;
- waits for Obsidian Sync to finish before doing either, after Obsidian
  starts or wakes from sleep, and while other devices' changes are still
  arriving. When Obsidian Sync reports it's idle, that's about 30 seconds
  after starting and 15 seconds after the last file change; when it can't
  tell, 3 minutes and 1 minute.

The status bar shows how many of your changes are still waiting to be sent.
**Send changes now** (in each share's settings, the command palette and the
ribbon) skips the wait. Use it before closing Obsidian if something is still
waiting.

With background tasks off, the device never talks to the mailbox on its own
and has no Send changes now button. You can still create, join and delete
shares there.

**Example:** you tick *Milk* on your phone in the shop. Obsidian Sync carries
the note to your desktop. Once Obsidian Sync has settled there, your desktop
sends it to the mailbox. Your roommate's desktop picks it up on its next
check, and their Obsidian Sync carries it to their phone. That takes a couple
of minutes, and both desktops need Obsidian open. If your roommate's desktop
is closed, the change waits in the mailbox until it's open again.

## Setup, part 1: the mailbox (once)

1. Go to [script.google.com](https://script.google.com) and click
   **New project**. Name it something like *Obsidian mailbox*.
2. Delete the sample code in `Code.gs` and paste in all of
   [`apps-script/Code.gs`](apps-script/Code.gs). Click **Save**.
3. In the function menu at the top, pick **setup** and click **Run**. Google
   asks for permission to use your Drive. Because this is your own script,
   Google shows an "unverified app" screen: click **Advanced**, then
   **Go to Obsidian mailbox**, then **Allow**.
4. Open **Execution log** and copy the **Owner code** it printed. Keep it to
   yourself: it can create and delete shares.
5. Click **Deploy → New deployment**. Click the gear and pick **Web app**.
   Set **Execute as: Me** and **Who has access: Anyone**, then click
   **Deploy**. Copy the **Web app URL** (it ends in `/exec`).
6. Optional check: open the URL in a browser. It should show
   `{"ok":true,"service":"shared-folder-sync"}`.

"Anyone" means anyone with the URL can reach the script, but the script
refuses every request that doesn't carry a valid code.

## Setup, part 2: your vault

1. Install the plugin through [BRAT](https://github.com/TfTHacker/obsidian42-brat)
   (**Add beta plugin** with `theshayneb/shared-obs-folder`) and enable it.
2. Open **Settings → Shared Folder Sync**. Under **Your mailbox**, enter the
   **Web app URL** and **Owner code** from part 1 and click **Test**.

## Setup, part 3: make a share

Do this once per person, or per group, you want to share with.

1. Under **New share**, type a name (for example *Groceries*) and click
   **Create**.
2. In the new share, fill in its paths, one per line, from the vault root:
   - **Folders**: `Reference/Grocery Items`
   - **Single files**: `Utilities/Bases/ShoppingList.base`
3. Click **Sync now**. The first sync uploads the share's notes.
4. Click **Copy invite** and send the invite to that person privately, such
   as in a direct message. Anyone with the invite can edit that share's
   notes, and nothing else.

A file or folder can be in more than one share. Edits from any of them reach
everyone in each share that holds it.

## Setup, part 4: the other person's vault

1. Install BRAT and this plugin the same way, and enable it.
2. Open **Settings → Shared Folder Sync**, paste the invite into
   **Join with an invite** and click **Join**.

The share's folders and files appear at the same paths as in your vault. If
you later change a share's folders or files, everyone who joined it follows
along on their next sync. Someone can join several shares, from you or from
other people, by joining each invite.

## Removing a share

- **Delete share** (on a share you created) deletes it from your mailbox. Its
  code stops working for everyone, and its data file in your Drive goes to
  the trash.
- **Leave** (on a share you joined) stops syncing it on this device.

Either way, the files already in each vault stay where they are.

## Tips for a grocery list

- Show `In_Stock` as a column in the Base's table view. Its checkbox can be
  ticked right in the table, and the tick syncs like any other edit.
- To add an item, create a note in `Reference/Grocery Items` with the usual
  properties. A template with `Type`, `Location`, `In_Stock: false` and the
  `grocery` tag makes this quick.
- The command palette has **Send changes now** and **Copy invite for a
  share**, and there's a send button in the ribbon.

## Updating the mailbox script

If `Code.gs` changes in a later version, paste the new code, then use
**Deploy → Manage deployments → Edit (pencil) → Version: New version →
Deploy**. That keeps the same URL, so nobody needs a new invite.

**Coming from 0.1.0?** After pasting the new code, run **setup** once more to
get your owner code, then redeploy as above. Your existing share code keeps
working: it becomes a share named *Shared folder* in your settings, and your
roommate doesn't need to do anything. Enter the URL and owner code under
**Your mailbox** to manage it like any other share.

**Coming from 0.2.0?** Update in this order:

1. Paste the new `Code.gs` and deploy a new version, as above. Version 0.3.0
   of the plugin refuses to sync with an older script, because the older
   script settles clashing edits by file time, which can lose edits. The new
   script still works with 0.2.0 plugins in the meantime.
2. Update the plugin on **every one of your devices**. Until a device updates,
   its old version keeps checking the mailbox and rewriting the plugin's
   settings file every 30 seconds, which is what made your devices fight.
   Your always-on device merges around it without losing anything, but the
   churn only stops once that device updates.
3. The people you share with can update when convenient.

Your shares and settings carry over. Each device's sync progress moves out of
the shared settings file into that device's own storage the first time it
syncs.

If the owner code leaks, run `resetOwnerCode` from the editor. Share codes
keep working. To cut off a share code, delete that share.

## Limits

- Changes take a minute or two, longer when they travel through Obsidian
  Sync first. Edits don't appear live, keystroke by keystroke, the way a
  shared Google Doc does.
- Google limits how much Apps Script can run each day on a free account. One
  always-on device per person checking every 30 seconds stays well within
  that. If syncs
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
(`git tag 0.1.1 && git push origin 0.1.1`), or run the **Release** workflow
from the Actions tab, which tags the version in `manifest.json`. It publishes
`main.js` and `manifest.json`, which BRAT installs.
