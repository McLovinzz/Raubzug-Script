/*
 * Die Stämme DE — Raubzug-Rechner · Schnellleisten-Edition v2.2.4
 * ----------------------------------------------------------------------------
 * Quickbar-Skript: läuft beim Klick auf den Schnellleisten-Button im Seiten-
 * kontext (direkter Zugriff auf game_data, ScavengeScreen, jQuery). KEINE
 * UserScript-Kopfzeile, kein Tampermonkey. Sendet nichts — füllt nur die
 * Truppen-Eingaben; losschicken machst du selbst.
 *
 * Einbinden (Premium nötig):  Einstellungen → Schnellleiste → neuer Eintrag,
 * als Link:
 *   javascript:$.getScript('https://cdn.jsdelivr.net/gh/DEINUSER/DEINREPO@main/raubzug-rechner.qb.js');void 0;
 *
 * Button öffnen, während der Raubzug-Bildschirm offen ist. Das Panel rechnet
 * sofort automatisch (alle Truppen zuhause, Rohstoffe/Stunde, max. 6 h — änderbar)
 * und füllt die 4 Vorlagen — Hotkeys 1–4 übernehmen sie in die Eingabe.
 * Ziel / Zeitlimit / Stufen lassen sich jederzeit umstellen (rechnet live neu).
 * Nacht-Modus: „Zurück bis Uhrzeit“ (z. B. 07:00) setzt das Limit bis genau
 * dahin und schaltet auf „pro Lauf“ — maximale Beute, die bis dann zurück ist.
 * Nochmal klicken = Panel aktualisiert sich (liest Truppen & Stufen neu).
 * Mehrfach-Klick ist sicher — es entstehen keine doppelten Panels/Zeilen.
 */

(function () {
    'use strict';

    const VERSION = '2.2.4-qb';

    // ------------------------------------------------------------------
    // Fallback data — only used when the page does not expose ScavengeScreen
    // (all values below are also what the game ships on a standard world).
    // ------------------------------------------------------------------
    const FALLBACK_CARRY = { spear: 25, sword: 15, axe: 10, archer: 10, light: 80, marcher: 50, heavy: 50, knight: 100 };
    const FALLBACK_POP = { spear: 1, sword: 1, axe: 1, archer: 1, light: 4, marcher: 5, heavy: 6, knight: 10 };
    const FALLBACK_TIERS = [
        { id: 1, name: 'Faule Sammler', lf: 0.10 },
        { id: 2, name: 'Bescheidene Sammler', lf: 0.25 },
        { id: 3, name: 'Kluge Sammler', lf: 0.50 },
        { id: 4, name: 'Großartige Sammler', lf: 0.75 },
    ].map((t) => Object.assign({ de: 0.45, di: 1800, df: 1 }, t));
    // Which units to hand out first when turning a capacity target into whole troops.
    // Big carriers first keeps the rounding error small; anything not listed is appended by carry.
    const UNIT_PRIORITY = ['light', 'heavy', 'marcher', 'knight', 'spear', 'sword', 'axe', 'archer'];
    const MIN_POP_FALLBACK = 10;

    const TEMPLATE_PREFIX = 'staemme_scav_tpl_';   // unchanged → existing templates keep working
    const SETTINGS_KEY = 'staemme_scav_settings';

    // --- CALC BEGIN --- (pure math, no DOM; identical to the verified userscript block)
    const Calc = {
        // Exactly what the game does in ScavengeOption.calcLoot / calcDurationSeconds.
        loot(t, cap) { return Math.round(cap * t.lf); },
        duration(t, cap) { return Math.round((Math.pow(100 * t.lf * t.lf * cap * cap, t.de) + t.di) * t.df); },
        durationC(t, cap) { return (Math.pow(100 * t.lf * t.lf * cap * cap, t.de) + t.di) * t.df; },
        // Inverse: the largest capacity whose run is not longer than D seconds (0 if even an empty run is too long).
        capForDuration(t, D) {
            if (!isFinite(D)) return Infinity;
            const x = D / t.df - t.di;
            if (x <= 0) return 0;
            return Math.sqrt(Math.pow(x, 1 / t.de) / (100 * t.lf * t.lf));
        },
        // Continuous split of `totalCap` across `tiers` (array of tier configs). Returns capacity per tier.
        split(tiers, totalCap, maxD, mode) {
            const n = tiers.length;
            const caps0 = new Array(n).fill(0);
            if (!n || !(totalCap > 0)) return caps0;
            const maxCap = tiers.map((t) => Calc.capForDuration(t, maxD));
            const byLoot = tiers.map((_, i) => i).sort((a, b) => tiers[b].lf - tiers[a].lf);

            if (mode === 'rpr') {
                // Loot per run is linear in capacity → fill the best tier first, spill over when the time cap binds.
                let rem = totalCap;
                const caps = caps0.slice();
                for (const i of byLoot) { const c = Math.min(rem, maxCap[i]); caps[i] = c; rem -= c; }
                return caps;
            }

            // Equal-duration split: duration depends on lf·cap only, so cap_i ∝ 1/lf_i (the classic 15:6:3:2).
            const invSum = tiers.reduce((s, t) => s + 1 / t.lf, 0);
            let caps = tiers.map((t) => totalCap / invSum / t.lf);
            if (mode === 'equal') {
                if (isFinite(maxD) && Calc.durationC(tiers[0], caps[0]) > maxD) caps = maxCap.slice();
                return caps;
            }

            // 'rph': maximise Σ loot_i / duration_i (each tier re-sent as soon as it returns).
            // The objective is concave in the caps, so pairwise moves with a halving step converge to the global optimum.
            const value = (c) => {
                let s = 0;
                for (let i = 0; i < n; i++) {
                    const x = Math.min(c[i], maxCap[i]);
                    if (x > 0) s += (x * tiers[i].lf) / Calc.durationC(tiers[i], x);
                }
                return s;
            };
            let best = value(caps);
            let improved = true;
            while (improved) {
                improved = false;
                for (let step = totalCap / 2; step >= 0.5; step /= 2) {
                    for (let a = 0; a < n; a++) {
                        for (let b = 0; b < n; b++) {
                            if (a === b || caps[b] <= 0) continue;
                            const mv = Math.min(step, caps[b]);
                            const trial = caps.slice();
                            trial[a] += mv; trial[b] -= mv;
                            const v = value(trial);
                            if (v > best + 1e-12) { best = v; caps = trial; improved = true; }
                        }
                    }
                }
            }
            return caps.map((c, i) => Math.min(c, maxCap[i]));
        },
        squadCap(squad, info) { let c = 0; for (const u in squad) c += (squad[u] || 0) * info[u].carry; return c; },
        squadPop(squad, info) { let p = 0; for (const u in squad) p += (squad[u] || 0) * info[u].pop; return p; },
        // Turn capacity targets into whole troops. Best tier is filled first; leftovers go to the best tier
        // that still has room under its time cap; squads below the game's population minimum are merged away.
        assign(tiers, caps, avail, info, priority, maxD, minPop) {
            const n = tiers.length;
            const left = Object.assign({}, avail);
            const byLoot = tiers.map((_, i) => i).sort((a, b) => tiers[b].lf - tiers[a].lf);
            const maxCap = tiers.map((t) => Calc.capForDuration(t, maxD));
            const squads = tiers.map(() => ({}));
            const notes = [];
            for (const i of byLoot) {
                let need = Math.round(Math.min(caps[i], maxCap[i]));
                for (const u of priority) {
                    if (!(left[u] > 0)) continue;
                    const k = Math.min(left[u], Math.floor(need / info[u].carry));
                    if (k > 0) { squads[i][u] = k; left[u] -= k; need -= k * info[u].carry; }
                }
            }
            // leftovers (rounding remainders) — never leave troops idle if a run can still take them
            for (const u of priority) {
                while (left[u] > 0) {
                    let placed = false;
                    for (const i of byLoot) {
                        if (!(caps[i] > 0)) continue;
                        if (Calc.squadCap(squads[i], info) + info[u].carry <= maxCap[i] + 1e-9) {
                            squads[i][u] = (squads[i][u] || 0) + 1; left[u]--; placed = true; break;
                        }
                    }
                    if (!placed) break;
                }
            }
            // population minimum: a squad the game would refuse is merged into its neighbour
            for (const i of byLoot) {
                const pop = Calc.squadPop(squads[i], info);
                if (pop > 0 && pop < minPop) {
                    const others = byLoot.filter((j) => j !== i && Calc.squadPop(squads[j], info) > 0);
                    const target = others.length ? others[0] : null;
                    if (target !== null) {
                        for (const u in squads[i]) squads[target][u] = (squads[target][u] || 0) + squads[i][u];
                        squads[i] = {};
                        notes.push(`Stufe ${tiers[i].id}: nur ${pop} Bevölkerung (< ${minPop}) → Einheiten zu Stufe ${tiers[target].id} verschoben.`);
                    } else {
                        notes.push(`Stufe ${tiers[i].id}: nur ${pop} Bevölkerung (< ${minPop}) — das Spiel schickt so einen Trupp nicht los.`);
                    }
                }
            }
            return { squads, leftover: left, notes };
        },
    };
    // --- CALC END ---

    // ------------------------------------------------------------------
    // Small helper: show a message using the game's own notifier when present.
    // ------------------------------------------------------------------
    function msg(text, isError) {
        try {
            if (window.UI && typeof UI.ErrorMessage === 'function') {
                (isError ? UI.ErrorMessage : (UI.SuccessMessage || UI.InfoMessage || UI.ErrorMessage))(text);
                return;
            }
        } catch (e) { /* ignore */ }
        console.log('[Raubzug] ' + text);
    }

    // ------------------------------------------------------------------
    // Page access — everything is read fresh on every "Berechnen" click.
    // ------------------------------------------------------------------
    const screenObj = () => (window.ScavengeScreen && window.ScavengeScreen.village) ? window.ScavengeScreen : null;

    function domUnits() {
        return Array.from(document.querySelectorAll('#scavenge_screen .candidate-squad-widget .unit_link[data-unit]'))
            .map((e) => e.getAttribute('data-unit'));
    }

    function readUnits() {
        const S = screenObj();
        const factor = (S && Number(S.village.unit_carry_factor)) || 1;
        let list = domUnits();
        const info = {};
        const fromGame = !!(S && S.sendable_units);
        if (!list.length && fromGame) list = Object.keys(S.sendable_units);
        list.forEach((u) => {
            const d = fromGame ? S.sendable_units[u] : null;
            info[u] = {
                carry: ((d && Number(d.carry)) || FALLBACK_CARRY[u] || 0) * factor,
                pop: (d && Number(d.pop)) || FALLBACK_POP[u] || 1,
                name: (d && (d.shortname || d.name)) || u,
            };
        });
        const priority = UNIT_PRIORITY.filter((u) => list.includes(u))
            .concat(list.filter((u) => !UNIT_PRIORITY.includes(u)).sort((a, b) => info[b].carry - info[a].carry));
        return { list, info, priority, factor, fromGame };
    }

    function readAvailable(list) {
        const S = screenObj();
        const home = S && S.village.unit_counts_home;
        const out = {};
        list.forEach((u) => {
            let n = home && home[u] != null ? Number(home[u]) : NaN;
            if (!isFinite(n)) {
                const el = document.querySelector(`#scavenge_screen .units-entry-all[data-unit="${u}"]`);
                n = el ? Number((el.textContent || '').replace(/\D/g, '')) || 0 : 0;
            }
            out[u] = n;
        });
        return out;
    }

    function readTiers() {
        const S = screenObj();
        if (S && S.village.options) {
            return Object.keys(S.village.options).map((k) => S.village.options[k])
                .filter((o) => o && o.base)
                .sort((a, b) => a.base.id - b.base.id)
                .map((o) => ({
                    id: o.base.id,
                    name: o.base.name,
                    lf: Number(o.base.loot_factor),
                    de: Number(o.base.duration_exponent),
                    di: Number(o.base.duration_initial_seconds),
                    df: Number(o.base.duration_factor),
                    status: typeof o.getStatus === 'function' ? o.getStatus()
                        : (o.is_locked ? 'locked' : (o.scavenging_squad ? 'active' : 'inactive')),
                    returnTime: o.scavenging_squad ? Number(o.scavenging_squad.return_time) : null,
                    fromGame: true,
                }));
        }
        const els = document.querySelectorAll('#scavenge_screen .scavenge-option');
        return FALLBACK_TIERS.map((t, i) => {
            const el = els[i];
            let status = 'inactive';
            if (el) {
                if (el.querySelector('.lock')) status = 'locked';
                else if (el.querySelector('.active-view, .return-countdown')) status = 'active';
            }
            return Object.assign({}, t, { status, returnTime: null, fromGame: false });
        });
    }

    const isIdle = (t) => t.status === 'inactive' || t.status === 'unavailable';

    function minPop() {
        const S = screenObj();
        const v = S && S.candidate_squad && Number(S.candidate_squad.min_pop_to_send);
        return v > 0 ? v : MIN_POP_FALLBACK;
    }

    function serverNow() {
        try { if (window.Timing && Timing.getCurrentServerTime) return Timing.getCurrentServerTime() / 1000; } catch (e) { /* ignore */ }
        return Date.now() / 1000;
    }

    // Fill the game's troop inputs. Prefer the game's own model API; fall back to synthetic input events.
    function fillSquad(units, counts) {
        const full = {};
        units.list.forEach((u) => { full[u] = Math.max(0, Math.floor(Number(counts[u]) || 0)); });
        const S = screenObj();
        if (S && S.candidate_squad && typeof S.candidate_squad.setUnitCounts === 'function') {
            try { S.candidate_squad.setUnitCounts(full); return; } catch (e) { /* fall through */ }
        }
        units.list.forEach((u) => {
            const input = document.querySelector(`#scavenge_screen .candidate-squad-widget input[name="${u}"]`);
            if (!input) return;
            input.value = full[u] || '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    // ------------------------------------------------------------------
    // Persistence
    // ------------------------------------------------------------------
    function villageId() { return (window.game_data && window.game_data.village && window.game_data.village.id) || 0; }
    function getTemplates() { try { return JSON.parse(localStorage.getItem(TEMPLATE_PREFIX + villageId()) || '{}'); } catch (e) { return {}; } }
    function saveTemplates(o) { try { localStorage.setItem(TEMPLATE_PREFIX + villageId(), JSON.stringify(o)); } catch (e) { /* ignore */ } }
    function getSettings() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; } }
    function saveSettings(o) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ } }

    // ------------------------------------------------------------------
    // Formatting
    // ------------------------------------------------------------------
    const fmtNum = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    function fmtDuration(sec) {
        if (!(sec > 0)) return '—';
        const d = Math.floor(sec / 86400), h = Math.floor(sec / 3600) % 24, m = Math.floor(sec / 60) % 60, s = Math.floor(sec) % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return (d ? d + 'd ' : '') + `${h}:${pad(m)}:${pad(s)}`;
    }
    function troopText(units, squad) {
        const parts = units.list.filter((u) => squad[u]).map((u) => `${fmtNum(squad[u])} ${units.info[u].name}`);
        return parts.length ? parts.join(', ') : '—';
    }
    function statusText(t) {
        switch (t.status) {
            case 'locked': return 'gesperrt';
            case 'unlocking': return 'wird freigeschaltet';
            case 'active': case 'pending': {
                const rem = t.returnTime ? t.returnTime - serverNow() : 0;
                return 'unterwegs' + (rem > 0 ? `, zurück in ${fmtDuration(rem)}` : '');
            }
            default: return 'frei';
        }
    }

    // ------------------------------------------------------------------
    // Core: compute a plan from the current page state
    // ------------------------------------------------------------------
    function computePlan(opts) {
        const units = readUnits();
        const tiers = readTiers();
        const avail = readAvailable(units.list);
        const selected = tiers.filter((t) => opts.selectedIds.includes(t.id));
        const totalCap = units.list.reduce((s, u) => s + avail[u] * units.info[u].carry, 0);
        const plan = { units, tiers, avail, selected, totalCap, rows: [], leftover: {}, notes: [], totals: { loot: 0, rph: 0 } };
        if (!selected.length || !(totalCap > 0)) return plan;

        const caps = Calc.split(selected, totalCap, opts.maxD, opts.mode);
        const { squads, leftover, notes } = Calc.assign(selected, caps, avail, units.info, units.priority, opts.maxD, minPop());
        plan.leftover = leftover;
        plan.notes = notes;
        plan.rows = selected.map((t, i) => {
            const cap = Calc.squadCap(squads[i], units.info);
            const loot = cap > 0 ? Calc.loot(t, cap) : 0;
            const dur = cap > 0 ? Calc.duration(t, cap) : 0;
            const rph = dur > 0 ? loot / dur * 3600 : 0;
            plan.totals.loot += loot; plan.totals.rph += rph;
            return { tier: t, squad: squads[i], cap, loot, dur, rph };
        });
        return plan;
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------
    function el(tag, props, ...children) {
        const e = document.createElement(tag);
        if (props) for (const k in props) { if (k === 'style') e.style.cssText = props[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]); else if (k in e) e[k] = props[k]; else e.setAttribute(k, props[k]); }
        children.forEach((c) => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
        return e;
    }

    function waitFor(selector, timeoutMs) {
        return new Promise((resolve, reject) => {
            const t0 = Date.now();
            const found = document.querySelector(selector);
            if (found) { resolve(found); return; }
            const obs = new MutationObserver(() => {
                const e = document.querySelector(selector);
                if (e) { obs.disconnect(); resolve(e); } else if (Date.now() - t0 > timeoutMs) { obs.disconnect(); reject(new Error('timeout: ' + selector)); }
            });
            obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
        });
    }

    // Remove any panel / template rows left by a previous click so a re-click refreshes instead of duplicating.
    function clearOld() {
        const old = document.getElementById('staemme-scav-calc');
        if (old) old.remove();
        document.querySelectorAll('tr[id^="staemme-template-"]').forEach((r) => r.remove());
    }

    async function main() {
        // Quickbar scripts run on demand, so guide the user if they clicked on the wrong screen.
        if (!/[?&]mode=scavenge(&|$)/.test(location.search)) {
            msg('Raubzug-Rechner: bitte zuerst den Raubzug-Bildschirm öffnen (Versammlungsplatz → Raubzüge), dann erneut klicken.', true);
            return;
        }
        let tbody;
        try { tbody = await waitFor('#scavenge_screen .candidate-squad-widget tbody', 8000); }
        catch (e) { msg('Raubzug-Rechner: Truppen-Tabelle nicht gefunden — Seite neu laden und erneut versuchen.', true); return; }

        clearOld();

        const units = readUnits();
        const tiers = readTiers();
        const settings = getSettings();
        console.log(`[Raubzug ${VERSION}] units:`, units.list, 'source:', units.fromGame ? 'ScavengeScreen' : 'fallback', 'tiers:', tiers.map((t) => `${t.id}:${t.status}`));

        // ---- template rows inside the game's squad table ----
        const templateInputs = {};   // templateInputs[t][unit] = input
        const templates = getTemplates();
        for (let t = 0; t < 4; t++) {
            const tr = el('tr', { id: `staemme-template-${t}` });
            templateInputs[t] = {};
            const tpl = templates[t] || {};
            units.list.forEach((u) => {
                const inp = el('input', { type: 'number', min: '0', style: 'width:44px', value: tpl[u] || 0, title: `Vorlage ${t + 1}: ${units.info[u].name}` });
                inp.addEventListener('change', () => { const o = getTemplates(); const row = o[t] || {}; row[u] = Math.max(0, Math.floor(Number(inp.value) || 0)); o[t] = row; saveTemplates(o); });
                templateInputs[t][u] = inp;
                tr.appendChild(el('td', null, inp));
            });
            const link = el('a', { href: '#', style: 'cursor:pointer', title: `Hotkey: ${'1234'[t]}` }, `Vorlage ${t + 1} anwenden`);
            link.addEventListener('click', (e) => { e.preventDefault(); fillSquad(readUnits(), getTemplates()[t] || {}); });
            tr.appendChild(el('td', { colSpan: 2 }, link));
            tbody.appendChild(tr);
        }

        // ---- calculator panel ----
        const panel = el('div', { id: 'staemme-scav-calc', style: 'margin:10px 0;padding:10px;border:1px solid #c8b98a;background:#f7f3e6;font-size:12px;' });
        panel.appendChild(el('div', { style: 'font-weight:bold;margin-bottom:6px;' }, `Raubzug-Rechner (Optimierung) · Schnellleiste v${VERSION}`));

        const modeLine = el('div', { style: 'margin-bottom:6px;' }, 'Ziel: ');
        const mkRadio = (val, label, title) => {
            const r = el('input', { type: 'radio', name: 'staemme-mode', value: val, checked: val === 'rph' });   // always open on Rohstoffe/Stunde
            return el('label', { style: 'margin-right:12px;cursor:pointer', title }, r, ' ' + label);
        };
        modeLine.appendChild(mkRadio('rph', 'Rohstoffe/Stunde', 'Maximiert den Dauerertrag, wenn jede Stufe sofort neu losgeschickt wird.'));
        modeLine.appendChild(mkRadio('rpr', 'Rohstoffe/Lauf', 'Maximiert die Beute eines einzelnen Durchgangs (alles in die beste Stufe, sofern die Zeitgrenze es zulässt).'));
        modeLine.appendChild(mkRadio('equal', 'Gleiche Dauer', 'Alle Stufen kommen gleichzeitig zurück (klassisches 15:6:3:2), praktisch zum Neu-Schicken in einem Rutsch.'));
        panel.appendChild(modeLine);

        const inH = el('input', { type: 'number', min: '0', style: 'width:50px', placeholder: 'h', value: '6' });   // opens with a 6 h limit by default (changeable)
        const inM = el('input', { type: 'number', min: '0', max: '59', style: 'width:50px', placeholder: 'm', value: '' });
        panel.appendChild(el('div', { style: 'margin-bottom:6px;' }, 'Max. Zeit weg: ', inH, ' h ', inM, ' m  (leer = unbegrenzt)'));

        // "Nacht-Modus": be back by a wall-clock time (e.g. 07:00). While set it overrides the h/m limit above.
        const inUntil = el('input', { type: 'time', style: 'width:90px' });
        const untilNote = el('span', { style: 'margin-left:8px;color:#777' }, '');
        panel.appendChild(el('div', { style: 'margin-bottom:6px;' }, 'Zurück bis Uhrzeit: ', inUntil, untilNote,
            el('span', { style: 'margin-left:8px;color:#777' }, '(Nacht-Modus: maximale Beute bis dahin, z. B. 07:00 — leer = aus)')));

        const tierLine = el('div', { style: 'margin-bottom:8px;' }, 'Stufen: ');
        const tierBoxes = {};   // id -> { box, label, touched }
        tiers.forEach((t) => {
            const box = el('input', { type: 'checkbox', checked: isIdle(t) });
            const lab = el('label', { style: 'margin-right:12px;cursor:pointer' }, box, ` ${t.id} ${t.name} `, el('span', { style: 'color:#777' }, `(${statusText(t)})`));
            box.addEventListener('change', () => { tierBoxes[t.id].touched = true; runCompute(); });
            tierBoxes[t.id] = { box, label: lab.lastChild, touched: false };
            tierLine.appendChild(lab);
        });
        panel.appendChild(tierLine);

        const btn = el('button', { type: 'button', class: 'btn', style: 'padding:4px 12px;cursor:pointer;', title: 'Liest die aktuellen Truppen neu ein und rechnet erneut' }, 'Neu berechnen');
        panel.appendChild(btn);
        panel.appendChild(el('span', { style: 'margin-left:10px;color:#777' }, 'Hotkeys 1/2/3/4 = Vorlage 1–4 in die Eingabe übernehmen'));
        // plain-language walkthrough — written for whoever is sitting the account
        panel.appendChild(el('div', { style: 'margin-top:8px;padding:6px 8px;background:#efe6c8;border:1px solid #c8b98a;font-weight:bold;' },
            'Ablauf:  Taste 1 drücken → bei Stufe 1 auf „Start“ klicken  ·  Taste 2 → Start  ·  Taste 3 → Start  ·  Taste 4 → Start.  Fertig — alle 6 h wiederholen.'));
        const res = el('div', { id: 'staemme-scav-result', style: 'margin-top:8px;white-space:pre-wrap;font-family:monospace;' });
        panel.appendChild(res);

        const container = document.querySelector('#scavenge_screen .candidate-squad-container');
        if (container && container.parentNode) container.parentNode.insertBefore(panel, container.nextSibling);
        else document.getElementById('scavenge_screen').appendChild(panel);

        // ---- compute (auto-runs on open; re-runs live on any control change, or via the button) ----
        function runCompute() {
            const mode = (panel.querySelector('input[name="staemme-mode"]:checked') || {}).value || 'rph';
            let maxD;
            const untilVal = (inUntil.value || '').trim();
            if (/^\d{1,2}:\d{2}$/.test(untilVal)) {
                // Nacht-Modus: limit = time until that clock time (today, or tomorrow if already past), minus a 1-min margin
                const parts = untilVal.split(':').map(Number);
                const now = new Date();
                const target = new Date(now); target.setHours(parts[0], parts[1], 0, 0);
                if (target <= now) target.setDate(target.getDate() + 1);
                maxD = Math.max(0, Math.floor((target - now) / 1000) - 60);
                untilNote.textContent = maxD >= 1800
                    ? `= noch ${fmtDuration(maxD)}`
                    : `= noch ${fmtDuration(maxD)} — zu kurz, kein Raubzug schafft das (min. 30 min)`;
            } else {
                untilNote.textContent = '';
                const h = Math.max(0, Number(inH.value) || 0), m = Math.max(0, Number(inM.value) || 0);
                const maxSec = (h * 60 + m) * 60;
                maxD = maxSec > 0 ? maxSec : Infinity;
            }
            saveSettings({ mode, h: inH.value, m: inM.value });

            // refresh tier status (squads may have returned since the panel opened); untouched boxes follow the status
            const fresh = readTiers();
            fresh.forEach((t) => { const tb = tierBoxes[t.id]; if (!tb) return; tb.label.textContent = `(${statusText(t)})`; if (!tb.touched) tb.box.checked = isIdle(t); });
            const selectedIds = fresh.filter((t) => tierBoxes[t.id] && tierBoxes[t.id].box.checked).map((t) => t.id);

            const plan = computePlan({ mode, maxD, selectedIds });
            const u = plan.units;
            const lines = [];
            const src = plan.tiers[0] && plan.tiers[0].fromGame ? 'aus dem Spiel gelesen' : 'FALLBACK (Standardwerte)';
            const t0 = plan.tiers[0] || FALLBACK_TIERS[0];
            lines.push(`Formel ${src}: Dauer = ((100·lf²·Kap²)^${t0.de} + ${t0.di}s) × ${t0.df}` + (u.factor !== 1 ? `  ·  Tragefaktor ${u.factor}` : ''));
            lines.push(`Modus: ${{ rph: 'Rohstoffe/Stunde', rpr: 'Rohstoffe/Lauf', equal: 'Gleiche Dauer' }[mode]}` + (isFinite(maxD) ? `  ·  max. ${fmtDuration(maxD)} weg` : '') + `  ·  Stufen: ${selectedIds.join(', ') || 'keine'}`);
            lines.push(`Zuhause: ${troopText(u, plan.avail)}  (Kapazität ${fmtNum(plan.totalCap)})`);
            lines.push('');

            if (!plan.totalCap) { res.textContent = lines.concat(['Keine Truppen zuhause — nichts zu berechnen.']).join('\n'); return; }
            if (!plan.selected.length) { res.textContent = lines.concat(['Keine freie Stufe ausgewählt (alle unterwegs oder gesperrt). Häkchen setzen, um trotzdem für später zu planen.']).join('\n'); return; }

            // store the plan in the 4 templates (template i ↔ Stufe i+1) and mirror it in the template inputs
            const store = getTemplates();
            plan.tiers.forEach((t) => {
                const row = plan.rows.find((r) => r.tier.id === t.id);
                const o = {}; u.list.forEach((x) => { o[x] = row ? (row.squad[x] || 0) : 0; });
                store[t.id - 1] = o;
                if (templateInputs[t.id - 1]) u.list.forEach((x) => { templateInputs[t.id - 1][x].value = o[x]; });
            });
            saveTemplates(store);

            plan.rows.slice().sort((a, b) => b.tier.id - a.tier.id).forEach((r) => {
                lines.push(`Stufe ${r.tier.id} ${r.tier.name}`);
                lines.push(`    Truppen: ${troopText(u, r.squad)}`);
                if (r.cap > 0) lines.push(`    Kapazität ${fmtNum(r.cap)} · Beute/Lauf ${fmtNum(r.loot)} · Dauer ${fmtDuration(r.dur)} · ${fmtNum(r.rph)} Rohstoffe/Stunde`);
                else lines.push('    (leer)');
            });
            lines.push('');
            lines.push(`Gesamt: Beute/Lauf ${fmtNum(plan.totals.loot)} · ${fmtNum(plan.totals.rph)} Rohstoffe/Stunde`
                + (Object.values(plan.leftover).some((x) => x > 0) ? ` · bleibt zuhause: ${troopText(u, plan.leftover)}` : ''));
            plan.notes.forEach((n) => lines.push('Hinweis: ' + n));
            res.textContent = lines.join('\n');
            console.log('[Raubzug] plan:', plan.rows.map((r) => ({ tier: r.tier.id, squad: r.squad, cap: r.cap, loot: r.loot, dur: r.dur })));
        }

        // live: any change to mode / time / tiers recomputes; the button re-reads current troops and recomputes
        btn.addEventListener('click', runCompute);
        panel.querySelectorAll('input[name="staemme-mode"]').forEach((r) => r.addEventListener('change', runCompute));
        inH.addEventListener('change', runCompute);
        inM.addEventListener('change', runCompute);
        inUntil.addEventListener('change', () => {
            // a wake-up time means one send with no re-sending → "pro Lauf" is the right objective for it
            if ((inUntil.value || '').trim()) { const r = panel.querySelector('input[name="staemme-mode"][value="rpr"]'); if (r) r.checked = true; }
            runCompute();
        });

        // auto-load on open: all troops at home, Rohstoffe/Stunde, 6 h limit (changeable), all free tiers
        runCompute();

        // ---- hotkeys (bind once per page load, even across repeated quickbar clicks) ----
        if (!window.__staemmeScavHotkeys) {
            window.__staemmeScavHotkeys = true;
            document.addEventListener('keydown', (ev) => {
                if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
                if (ev.target && /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) return;
                const idx = '1234'.indexOf(ev.key);
                if (idx < 0) return;
                fillSquad(readUnits(), getTemplates()[idx] || {});
            });
        }

        msg(`Raubzug-Rechner v${VERSION} bereit.`);
        console.log(`[Raubzug ${VERSION}] ready — inline calculator + 4 templates added.`);
    }

    main().catch((err) => { console.error('[Raubzug] fatal:', err); msg('Raubzug-Rechner: Fehler — siehe Konsole (F12).', true); });
})();
