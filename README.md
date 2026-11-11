# Grief to Ban

Mindustry v146+ mod (pure Rhino JS) that turns griefers into spectators instead of
silently letting them wreck the map.

- UID blacklist: names on it get switched to team 0 (derelict) the moment they join
- Optional vanilla blacklist: write straight into the game's ban list instead
- Language watchlist: auto-blacklist or auto-watch players by client locale
- Behaviour rules: mass command / self-replicating logic / thorium reactor too close to
  a core / reactor about to blow / blast compound in generators / AFK unit control
- /vote kick target is parked on team 0 until the vote ends
- Settings live in game settings (hammer icon) and in the ESC pause menu

Install: drop the GriefToBan folder into saves/mods/ (or import the mod zip through the
in-game mod importer), then restart the game.

Build a release package:

    python -X utf8 tools/package_gtb.py

Tests (need Node.js and a Mindustry server jar for the probe):

    python -X utf8 tests/grief-to-ban/run_gtb_tests.py
    python -X utf8 tests/grief-to-ban/run_server_probe.py

Changelog: GriefToBan/CHANGELOG.md
