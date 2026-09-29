---
"@gyst/cli": minor
---

Add a browser viewer for saved sessions. `gyst`, `gyst <range>` and `gyst --session <id>` open (or create) the session, serve a private viewer on a new `*.localhost` host name bound to `127.0.0.1`, and open it in your browser or print a one-time link; stop it with Ctrl-C. The link's secret expires 10 minutes after launch, after which that browser stays signed in until the viewer stops. The viewer lists saved sessions, shows each one's captured diff and deletes a session after confirmation. Over SSH, forward a local port to the printed port and open the link with your local port.
