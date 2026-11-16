# Caelancraft server

One program hosts a world for everyone on the home network: it serves the game to every browser and keeps the shared
world. The host plays in a browser like everyone else.

```bash
npm install          # once (the server needs the `ws` package)
npm run build        # the game the server hands out (dist/)
npm run server       # node server/index.js: port 4180, world "home"
```

It prints the addresses to open. On this PC: `http://localhost:4180/`. On an iPad: `http://<the PC's address>:4180/`, then
**Play together → Join** on the title screen. (In Safari, Share → *Add to Home Screen* makes it open full screen.)

Options: `--port 4180`, `--world home` (a folder under `server/worlds/`), `--seed 42` (a new world only), `--host 0.0.0.0`,
`--client dist`, `--worlds server/worlds`.

The world is saved to `server/worlds/<world>/world.json` every 30 seconds while something changes and when the server stops
(Ctrl+C), with a copy in `backups/` every 30 minutes (the newest 10 kept). Each player is known by a token their browser
keeps, so a player who comes back is put back where they left.

Phase 1 (now): a shared Creative world — building, bricks, water and falling sand (the server runs them), the clock, chat
(T), everyone drawn as their avatar with their name. Mobs, devices and Survival together come in the next phases
(`docs/DESIGN-multiplayer.md`).

## Letting the iPads in when the server runs under WSL2

WSL2 normally sits behind its own little network (NAT), so other devices cannot reach a server running inside it. Pick one
of these, once. Both need an administrator PowerShell on Windows, and the home Wi-Fi set to a **Private** network (Windows
Settings → Network → Wi-Fi → the network → Private).

**A. Mirrored networking (simplest, survives reboots).** Put this in `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

then in PowerShell `wsl --shutdown`, open WSL again, and allow the port through both firewalls:

```powershell
New-NetFirewallRule -DisplayName "Caelancraft 4180" -Direction Inbound -Protocol TCP -LocalPort 4180 -Action Allow -Profile Private
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
```

The iPads then open `http://<the PC's Wi-Fi address>:4180/` (`ipconfig` shows it: *Wireless LAN adapter Wi-Fi → IPv4*).

**B. A port forward (no WSL change; redo it after a reboot, when WSL's address changes).** In WSL, `hostname -I` gives WSL's
address; then in an administrator PowerShell:

```powershell
netsh interface portproxy add v4tov4 listenport=4180 listenaddress=0.0.0.0 connectport=4180 connectaddress=<WSL address>
New-NetFirewallRule -DisplayName "Caelancraft 4180" -Direction Inbound -Protocol TCP -LocalPort 4180 -Action Allow -Profile Private
```

To undo: `netsh interface portproxy delete v4tov4 listenport=4180 listenaddress=0.0.0.0` and
`Remove-NetFirewallRule -DisplayName "Caelancraft 4180"`.

A fixed address for the PC (a DHCP reservation in the router) keeps the iPads' bookmark working.

## Later: a real server

The same program runs on any machine with Node 22.12+. Put it behind a reverse proxy that terminates HTTPS (the page then
connects with `wss://`), and see phase 4 of `docs/DESIGN-multiplayer.md` (passwords or invite codes, rate limits, admin
commands). A page served from elsewhere can name a server with `?server=host:port`.
