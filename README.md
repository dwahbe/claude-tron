# claude-tron

Multiplayer light cycles you play inside Claude Code, as the `lightcycles` plugin. Everyone shares one online lobby: neon trails, bots to keep it lively, a leaderboard, and a walled arena that grows and shrinks with the number of riders.

## Play

You need Claude Code 2.1.287 or later, or the Claude desktop app. In a session:

```
/plugin marketplace add dwahbe/claude-tron
/plugin install lightcycles@lightcycles
```

Then type `/cycles`, or `/cycles YourName` to pick a name; it's remembered. Steer with **W A S D**. If the keys go to the prompt, click the pane first. `/cycles leave` leaves the lobby.

The public lobby runs on a free host that sleeps when nobody's playing, so the first rider in may wait about a minute while it wakes up.

## Rules

- Ride into a wall, any trail (yours too), or another rider head-on, and you're derezzed. You're back in 1.5 seconds.
- Your score is the length of your current run. You get a kill when someone crashes into your trail.
- The arena gives each rider about 55×55 cells, so its side grows with the square root of the rider count. It grows at once when someone joins. When riders leave, it waits 5 seconds, then the wall turns red and closes in at 2.5 cells a second, a quarter of riding speed. It derezzes anyone it catches.

## What the plugin does on your machine

lightcycles is a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview): code that runs inside Claude Code with your permissions. This one only:

- calls the lobby's URL over HTTP(S)
- keeps your rider name and the last lobby you joined in its own plugin store
- draws its pane

It starts no processes, and it reads no files or environment variables. To check before installing, clone the repo and run `claude plugin validate plugins/lightcycles`: the `calls:` line lists everything it uses.

## Run your own lobby

**On Render (free):** fork this repo, then in Render choose **New → Blueprint** and pick your fork. `render.yaml` sets up the service. Join it with `/cycles join https://<your-service>.onrender.com`, or change `PUBLIC_LOBBY` in `plugins/lightcycles/hooks/register.tsx` to make it the default.

**Anywhere else:** the server is one file with no dependencies. Run it with [bun](https://bun.sh):

```
bun server/server.ts --host 0.0.0.0 --bots 4
```

It listens on `$PORT` when set, otherwise `--port` (default 7777). It serves plain HTTP, so put HTTPS in front of it for public use.

**On your machine:** `bun server/server.ts`, then `/cycles join http://127.0.0.1:7777`.

## Develop

```
claude plugin validate plugins/lightcycles
claude plugin test plugins/lightcycles
```

To try local changes in Claude Code, add this folder as a marketplace with `/plugin marketplace add /path/to/lightcycles` and install from it. Run `/reload-plugins` after you edit.

If you change the frame format, bump `PROTOCOL` in `plugins/lightcycles/hooks/protocol.ts`. Riders on an older plugin are then told to update instead of seeing a broken board.
