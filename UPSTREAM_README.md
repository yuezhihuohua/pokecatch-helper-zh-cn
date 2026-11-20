# Poke'Catch Team Optimizer

A Tampermonkey helper for [Poke'Catch](https://pokecatch-online.netlify.app/) that

- **simulates a whole chapter** with the game's own battle rules and finds the team of 6 with the
  highest completion rate (wilds, trainers, gyms, heal stops, statuses, XP and evolutions included),
- does the same for **legendary battles** (every legend zone and its five elite tiers) with win
  chance, run time and capture odds,
- optimizes **shiny raids** (DPS badges on every pick/ally suggestion and a one-click fastest clear),
- **watches the team** and records where a wipe happens,
- and **applies** a team to the game by dragging mons into the real slots, like a player.

All Pokémon and move names are **English** — when the page runs in another language, the script
reads `/boot.js`, finds the English pack (`bundle/lang-en.<hash>.js`) and loads it for its own
labels.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open `pokecatch-team-optimizer.user.js` → Tampermonkey offers to install it.
3. Open <https://pokecatch-online.netlify.app/> and log in. There is **no floating window**:
   the helper's data lives inside the game's own screens (see below), styled with the game's
   CSS so it reads as part of the UI. Blocks only rebuild when something changed, so nothing
   flickers while the game plays. The block title shows the running version.

## Where everything is

| Game screen | What the helper adds there |
|---|---|
| **Progress** | Run monitor: chapter, step and cap; data source and bundle; eligible count; league info; errors and the update notice; the chapter's events with the type chips; the **wipe watcher** with its log. |
| **Adventure** | Between the route timeline and the arena, the game's **team-template bar** (same markup, sprites and active state): one click fields that template, which the segment watcher then leaves alone until the next center. |
| **Team/PC** | The **chapter optimizer** above the PC list: presets, **simulate** with the progress bar, the simulation result, the team with each mon's move and a `moves`/`api` button, **apply to team**, **prepare segments** (one team per stretch between Pokémon Centers, stored in the game's free team templates) and **free all templates** (let the planner reuse every template; the game has no delete, so the next prepare overwrites them). |
| **Legendary team picker** (any legend zone) | The **legendary optimizer**: the boss with its HP and damage, the odds line, presets, **✨ Optimize (mine)**, the team and **apply to team**. |
| **Raid team picker** ("Raid vs boss") | The **raid optimizer**: **⚡ Fastest clear**, the DPS line and an `atk` badge on every pick/ally suggestion. |

The **Defense / Offense / Balanced** presets order the candidate pool the search starts from
(survivability, damage, or the balance of both); the final team is the one that wins the
simulation.

## The chapter simulator

The **simulate** button is a full run simulation of the chapter the game generated, not a per-foe
score:

- it walks the chapter's real node list in order — wild encounters, random trainers, story
  trainers, gym leaders, heal stops. A **league** chapter is built by the game with all five
  members' paths; the sim walks them all, and a wipe still rewinds the league to its first member.
- battles use the game's own rules, ported from its bundle: every living mon acts each round in
  speed order (paralysis ×0.25 speed), OHKO-capable moves are preferred, **status moves are used
  with the game's 30 % chance** (accuracy capped 100/70/30 by move kind, immunity by type), else the
  best attack; damage rolls 0.85–1.15, crits, multi-hits and secondary status effects per hit.
- statuses behave exactly as in game: sleep 1–3 turns, freeze until a 0.2 thaw, full-para 0.25 with
  a 3-turn cap, burn/poison tick `maxHp/8` for 5 turns, the 0.75 stat cuts, confusion self-hits,
  night-sleep on diurnal wilds — and they **persist between fights** until a heal.
- the team keeps its HP between fights, gains the game's XP per defeated foe and **levels up
  mid-run**: new moves from the graded learnset, evolutions with their gates; the panel shows the
  form each mon becomes at the cap (`Mascaïman → Krookodile · Lv32 → 100`).
- the search is a hill climb over the strongest pool (Monte-Carlo runs per team, one mon per
  species), scored by completion rate. The result line reads like
  `chapter sim: win 62% · clears 19/24 battles · 121 teams in 1.1s · wipe at step #7×3`.

### Segment teams (one per Pokémon Center)

A chapter is split at its **heal nodes**; each stretch is simulated on its own (starting from a
healed team, which is what a Pokémon Center gives you). **prepare segments** computes a team for
each stretch and stores it in a **free** team template of the game (`#team-sets`) — your own
templates are never overwritten. While the run is in a chapter that has prepared segments, the
script watches the node and switches **one node before each Pokémon Center** — the game heals when
the center node starts, so a team fielded at the center itself would miss the heal. The chapter
block lists the prepared segments as `#slot team…`. The plan survives a page reload: the
segment→template map is kept next to the data cache, so switching resumes where the run is.

A **wipe restarts the chapter**, so the script drops the current segment and fields **segment 1's
template** again as soon as the run is back at the start.

The game has no "delete template" action, so **free all templates** cannot empty them: it releases
the segment plan and lets the next **prepare segments** overwrite every template (it asks first,
and the filled templates are only replaced when you prepare). To switch by hand, the game's own
template bar sits on the Adventure screen between the timeline and the arena: click a template and
the watcher leaves your pick alone until the next Pokémon Center.

## Legendary battles

Open a legend zone's team picker, then **✨ Optimize (mine)**: the boss fights the whole team every
round (main move + burst + counter, like the game), scales with the team's shiny/level and uses the
elite tables. The fight is simulated at the level the game brings the team to — the **zone's level**
(100) or the max level for an elite tier — starting from a **healed team**, which is how a
legendary fight always begins.

Under the boss the line tells you what the fight costs:

| Number | Meaning |
|---|---|
| **win %** | victory chance, from 200 simulated fights with the game's rolls |
| **rounds ≈ time/run** | length of one attempt (~2.5 s per round at the game's fast speed, scaled by your speed) |
| **catch %/run** | capture chance of one successful attempt (the game's formula: `captureRate × 0.6 / 255`, legendary `3/255`, times your capture-berry buff) |
| **~N runs ≈ total time** | expected attempts and wall-clock time, capped by the raid pity (150 tries) |

## Shiny raids

In the game's raid picker ("Raid vs *boss*") my row adds a **⚡ Fastest clear** button:

- every suggestion carries an **atk** badge — the expected damage per round against the raid boss,
  using the game's own raid knobs (`BOSS.HP/POWER × (BST_REF/BST)^exp × ADJ`, shiny boss, the
  6-slot HP scaling) and accuracy-weighted;
- the community species cards in the picker and every ally row in "Pick an ally" are annotated
  (the ally score is the sum of the two mons shown in the row);
- the button fills your two pick slots with the highest-DPS mons (any PC mon is allowed, capped at
  the raid level, one per species), then walks the ally slots and picks the two best allies;
- the line reports the total: `team dps 2.1k (mine 831 + allies 1279) · Swablu 10 rounds to break`.

## Inside the game, beside its own buttons

The game has its own **Optimize** button in the team pickers and its own controls in the Team/PC
header. The helper's blocks sit right there, built from the game's own classes, and their buttons
fill the game's own slots — the two optimizers work side by side and both write to the game.

## Wipe watcher

The game heals the team the instant it is wiped, so an "all knocked out" state never lasts. The
watcher reads the game's own counters instead: `adv.deaths[chapter]` for a normal chapter,
`adv.league.tries` for a league run and `adv.zone.tries` for an elite legend zone (the 2026-11
update stopped counting league and elite wipes in `deaths`). Each record holds the step the team
fell on, the foes, your team and the wipe mode (chapter / league / elite zone).

## Where the data comes from

- **The game itself** — the script parses the bundle the page already loaded
  (`bundle/app.<hash>.js`): Pokédex, moves, evolutions, chapters, encounters, the config knobs and
  the legend zones. The per-species learnset is recomputed with the game's own grading algorithm
  (the 2026-11 re-grading: a 20-level gap cap, per-type level reassignment by weight, a per-species
  4–5 spacing step), so the recommended attacks are exactly the ones the game allows at the cap —
  verified equal to the game's own algorithm on all 649 species.
- **https://pokemondb.net/type** — the type chart (identical to the game's), with PokeAPI and the
  game chart as fallbacks.
- **https://pokeapi.co/api/v2** — cross-check of types and level-up learnsets.

Tables are cached in userscript storage keyed by the bundle hash and validated on load: an
implausible or half-read table is thrown away and re-parsed.

## When the game updates

The game rewrites its bundle on every release, including the minified names the script reads. The
parser never trusts a minified name: it locates tables by their public markers (`a.POKEDEX=`,
`a.CONFIG=`…) or by the shape of the data, and reads legend zones through the public
`a.LegendZones` export. Each table parses on its own; one the update broke is named in the panel
(`bundle parse failed: game update changed the bundle: MOVES — …`) while the rest keeps working.

Every action is logged to the console with a `[pcopt]` prefix — bundle parse with table sizes,
cache hits, chart source, optimizer runs and their teams, applied slots, injections, raid/legend
runs, wipes and their mode, and every error. The last 400 entries are in `window.__pcopt.logs`.

### Automatic updates

The script declares `@updateURL` / `@downloadURL` at the raw file on GitHub `main`, so Tampermonkey
pulls every release by itself — no reinstall — **as long as `@version` changed** (it does, on every
release; the panel header shows the running version). Tampermonkey checks on its own schedule
(dashboard → Settings → **Update** → check interval), or force it from the toolbar (⚙ → *Check for
updates*). GitHub raw caches for ~5 minutes.

The script also checks once per page load and shows
`update 1.6.2 is on GitHub (installed 1.6.0) — Tampermonkey → Check for updates` as soon as a
newer version exists, and it removes the previous version's floating panel and quick-optimize
rows from the page, so after an update only the blocks' controls remain (reload the page once
after installing). For truly instant updates, install from a **local clone** instead:
Tampermonkey re-reads a `file://` script when it changes (needs *Allow access to file URLs*).

## Notes and limits

- **Level cap projection.** The team is evaluated at the cap the game currently allows: the next
  gym you still owe in any **open** region (travel list, region-link destination, unlocked
  chapters), ace + margin — so a mid-region chapter gives its own cap (48 on *Badge Jet*) rather
  than the max level. The team rows read `Lv48 → cap`.
- **Shiny** Pokémon get the game's +10 % stat bonus and are marked ✨.
- **Eligibility.** Only mons the game accepts join an adventure team (region link, one per species);
  the **raid** picker accepts any PC mon.
- **Evolutions.** Level evolutions within the cap are projected, with the game's gates: daytime
  (`TIME_EVOLUTIONS`), the party requirement (e.g. Mantyke needs a Remoraid), and the uid-hash pick
  when several level branches qualify. Item evolutions count only when the item is in the current
  region's bag; **link-cable** evolutions count when your wallet covers the game's trade fee
  (computed with the game's own tier formula). The legend optimizer scores every reachable branch;
  the chapter sim evolves the real mon as it levels. The game's dex-dedup evolution gate is not
  modelled.
- **Random trainers** are rolled like the game's encounter builder (team size, level bonus,
  evolved chance, doubles/triples odds) and wilds are sampled from the node's live pool.
- **Raid bosses** are optimized for DPS and clear time; their fight is not simulated round by round
  like the chapter.
- The simulator is a model: expected rolls and the game's probabilities, not frame-perfect.
