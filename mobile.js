/**
 * Dilou — vue mobile du calendrier (téléphone, dans le navigateur).
 *
 * Sur un petit écran, la vue Calendrier devient : alertes des changements de cours signalés par mail, bascule
 * Devoirs / Emploi du temps, semaine en bandeau et le jour choisi en liste. L'emploi du temps vient de l'app
 * Calendrier d'un Mac de Louise, partagé par l'app Dilou (AppState.agenda) ; sans lui, seuls les devoirs s'affichent.
 * Inactive dans l'app Mac (qui a sa propre vue) et sur grand écran. Cocher / valider passent par les fonctions de
 * la page (toggleSubtask, toggleValidateTask) : rien de nouveau côté données.
 */
(function () {
  'use strict';
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dilou) return;   // app Mac

  const ecran = window.matchMedia('(max-width: 760px)');
  const CLE_MODE = 'dilou-mobile-mode';
  let mode = 'devoirs';
  try { if (localStorage.getItem(CLE_MODE) === 'edt') mode = 'edt'; } catch { /* stockage indisponible */ }
  let jour = null;                 // jour affiché (AAAA-MM-JJ)
  const deplies = new Set();       // devoirs dépliés
  const alertesOuvertes = new Set();
  let pause = 0;                   // pas de redessin pendant que le liquide monte
  let racine = null;

  // --- Outils ----------------------------------------------------------------------------------------------------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pret = () => typeof AppState !== 'undefined' && Array.isArray(AppState.tasks)
    && typeof isoLocal === 'function' && typeof mondayOfWeek === 'function';
  const actif = () => ecran.matches;
  const dateDe = iso => { const [a, m, j] = iso.split('-').map(Number); return new Date(a, m - 1, j); };
  const plus = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const aujourdhui = () => isoLocal(new Date());
  const ouvert = t => t.status !== 'archived';
  const evaluation = t => (typeof estEvaluation === 'function' ? estEvaluation(t) : t.kind === 'evaluation');
  const creneau = t => evaluation(t) || (typeof estCreneau === 'function' && estCreneau(t));
  const visible = t => (typeof correspondFiltre === 'function' ? correspondFiltre(t) : true);
  const trier = (a, b) => (typeof comparerTaches === 'function' ? comparerTaches(a, b) : 0);
  const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;
  const maj = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const minutes = s => { const m = /(\d{1,2})[:h](\d{2})/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
  const hhmm = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  const lienMail = u => (typeof safeEmailUrl === 'function' ? safeEmailUrl(u) : null);

  const principales = () => (typeof MATIERES_PRINCIPALES !== 'undefined' ? MATIERES_PRINCIPALES
    : ['LA21', 'MT03', 'MT02', 'PS21', 'IS00', 'GE28', 'NP90', 'PS90']);
  function matiere(c) {
    c = String(c || '').toUpperCase();
    if (c === 'PS90') return 'NP90';
    return principales().includes(c) ? c : 'CAMPUS';
  }
  const couleurs = {};
  function couleur(c) {
    const k = matiere(c);
    if (couleurs[k]) return couleurs[k];
    const point = document.querySelector(`.filter-pill[data-course="${k}"] .pill-dot`);
    const v = point ? getComputedStyle(point).backgroundColor : '';
    return (couleurs[k] = v && v !== 'rgba(0, 0, 0, 0)' ? v : '#9a9a9a');
  }
  const MOTS = [[/espagnol/i, 'LA21'], [/alg[eè]bre/i, 'MT02'], [/\banalyse\b/i, 'MT03'], [/m[ée]canique/i, 'PS21'],
    [/environnement/i, 'IS00'], [/\bdroit\b/i, 'GE28'], [/nano.?projet/i, 'NP90']];
  /** Matière d'un cours d'après son titre (« 📏 MT02 - C2 (2/2) » → MT02), ou null (sport, activités…) */
  function matiereDans(texte) {
    const s = String(texte || '');
    const code = (s.toUpperCase().match(/\b[A-Z]{2}\d{2}\b/g) || []).find(c => principales().includes(c));
    if (code) return matiere(code);
    const mot = MOTS.find(([re]) => re.test(s));
    return mot ? mot[1] : null;
  }
  const propre = s => String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

  // --- Changements de cours annoncés par mail (même repérage que l'app Mac) ----------------------------------------
  const CHANGEMENT = /(annul|d[ée]plac|d[ée]cal|report[ée]|reprogramm|distanciel|en visio|changement d[e']\s*(salle|date|cr[ée]neau|horaire)|nouvelle salle|salle chang|cours remplac)/i;
  const MOIS = { jan: 0, janv: 0, fev: 1, fevr: 1, fév: 1, févr: 1, mars: 2, avr: 3, mai: 4, juin: 5, juil: 6, aout: 7, août: 7,
    sep: 8, sept: 8, oct: 9, nov: 10, dec: 11, déc: 11 };
  function changement(texte, cours, echeance) {
    const m = CHANGEMENT.exec(texte);
    if (!m) return null;
    const mat = matiereDans(texte.slice(Math.max(0, m.index - 90), m.index + 90)) || (cours ? matiere(cours) : null);
    const dates = new Set(echeance ? [echeance] : []);
    const maintenant = new Date();
    const re = /\b(\d{1,2})(?:er)?\s+(janv|jan|févr|fevr|fév|fev|mars|avr|mai|juin|juil|août|aout|sept|sep|oct|nov|déc|dec)[a-zéû]*\.?/gi;
    for (let x; (x = re.exec(texte));) {
      const mo = MOIS[x[2].toLowerCase()];
      if (mo == null || +x[1] > 31) continue;
      let d = new Date(maintenant.getFullYear(), mo, +x[1]);
      if (d - maintenant < -180 * 86400000) d = new Date(maintenant.getFullYear() + 1, mo, +x[1]);
      dates.add(isoLocal(d));
    }
    return { matiere: mat, dates: [...dates].sort() };
  }
  function alertes() {
    const depuis = isoLocal(plus(new Date(), -1)), jusqua = isoLocal(plus(new Date(), 21));
    const liste = [];
    const ajouter = (id, texte, cours, echeance, titre, detail, mail, tache) => {
      const info = changement(texte, cours, echeance);
      if (!info) return;
      const quand = info.dates.find(d => d >= depuis && d <= jusqua);
      if (!quand && info.dates.length) return;
      liste.push({ id, matiere: info.matiere, quand, titre, detail, mail, tache, dates: info.dates });
    };
    for (const t of AppState.tasks) {
      if (!ouvert(t) || !visible(t)) continue;
      ajouter('t:' + t.id, [t.title, t.notes, t.emailSubject].filter(Boolean).join(' '), t.course, t.dueDate,
              t.title, t.notes || '', t.emailUrl, t.id);
    }
    for (const s of AppState.supervisionItems || []) {
      ajouter('s:' + s.id, [s.emailSubject, s.snippet, s.reason].filter(Boolean).join(' '), s.course, null,
              s.emailSubject || 'Courriel à trier', s.snippet || '', s.emailUrl, null);
    }
    return liste.sort((a, b) => String(a.quand || '9').localeCompare(String(b.quand || '9'))).slice(0, 6);
  }

  // --- Emploi du temps partagé par le Mac -------------------------------------------------------------------------
  /** Cours et activités d'un jour, ou null si l'emploi du temps ne couvre pas ce jour */
  function evenements(iso) {
    const ag = AppState.agenda;
    if (!ag || !Array.isArray(ag.events) || !ag.from || iso < ag.from || iso > ag.to) return null;
    const liste = [];
    for (const e of ag.events) {
      const dd = String(e.start).slice(0, 10), df = String(e.end).slice(0, 10), fin = minutes(String(e.end).slice(11)) || 0;
      if (e.allDay ? !(dd <= iso && (iso < df || dd === iso)) : !(dd === iso || (dd < iso && (df > iso || (df === iso && fin > 0))))) continue;
      const debut = !e.allDay && dd === iso ? minutes(String(e.start).slice(11)) || 0 : 0;
      const mat = matiereDans(e.title);
      liste.push({ titre: propre(e.title), debut, fin: Math.max(!e.allDay && df === iso ? fin : 24 * 60, debut + 15),
        journee: !!e.allDay, lieu: e.location || '', calendrier: e.calendar || '', matiere: mat,
        c: mat ? couleur(mat) : (e.color || '#9a9a9a'), devoirs: [], alertes: [] });
    }
    return liste;
  }
  function progression(t) {
    const subs = t.subtasks || [], faits = subs.filter(s => s.completed).length;
    return { subs, faits, total: subs.length, pct: t.status === 'archived' ? 100 : subs.length ? Math.round(faits / subs.length * 100) : 0 };
  }

  // --- Rendu ------------------------------------------------------------------------------------------------------
  const ICONE = {
    liste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6.5 1.5 1.5L8 5.5M4 12.5 5.5 14 8 11.5M4 18.5 5.5 20 8 17.5M11 7h9M11 13h9M11 19h9"/></svg>',
    horloge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
    alerte: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/></svg>',
    gauche: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>',
    droite: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
  };

  function carte(t, compacte = false) {
    const p = progression(t), fait = !ouvert(t), deplie = deplies.has(t.id);
    const quand = [typeof horaire === 'function' ? horaire(t) : (t.time || ''), t.location].filter(Boolean).join(' · ');
    const mail = lienMail(t.emailUrl);
    const liquide = p.total && typeof getLiquidFillHTML === 'function' ? getLiquidFillHTML(p.pct) : '';
    return `<article class="dm-card ${evaluation(t) && !fait ? 'is-eval' : ''} ${fait ? 'is-done' : ''} ${compacte ? 'is-compact' : ''}"
        style="--c:${couleur(t.course)}" data-card="${esc(t.id)}">${liquide}
      <button type="button" class="dm-card-head" data-deplier="${esc(t.id)}" aria-expanded="${deplie}">
        <span class="dm-card-top"><i></i><b>${esc(t.course)}</b>
          ${evaluation(t) && !fait ? '<em class="dm-pill is-eval">Évaluation</em>' : ''}${fait ? '<em class="dm-pill is-done">Validé</em>' : ''}
          ${p.total ? `<span class="dm-count">${p.faits}/${p.total}</span>` : ''}</span>
        <span class="dm-card-title">${esc(t.title)}</span>
        ${quand ? `<span class="dm-card-meta">${esc(quand)}</span>` : ''}
      </button>
      ${deplie ? `<div class="dm-card-body">
          ${t.notes ? `<p class="dm-notes">${esc(t.notes)}</p>` : ''}
          ${p.subs.map(s => `<button type="button" class="dm-sub ${s.completed ? 'is-done' : ''}" data-sub="${esc(s.id)}" data-tache="${esc(t.id)}">
              <span class="dm-check"></span><span>${esc(s.title)}</span></button>`).join('')}
          <div class="dm-actions">
            ${mail ? `<a class="dm-btn" href="${esc(mail)}" target="_blank" rel="noopener noreferrer">Mail d'origine</a>` : ''}
            <button type="button" class="dm-btn is-primary" data-valider="${esc(t.id)}">${fait ? 'Rouvrir' : 'Valider le devoir'}</button>
          </div>
        </div>` : ''}
    </article>`;
  }

  function vueAlertes(liste) {
    if (!liste.length) return '';
    return `<section class="dm-alerts" aria-label="Changements signalés par mail">
      <h3>${ICONE.alerte}${pluriel(liste.length, 'changement signalé', 'changements signalés')} par mail</h3>
      ${liste.map(a => {
        const d = a.quand ? maj(dateDe(a.quand).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })) : 'Date à préciser';
        const vu = alertesOuvertes.has(a.id), mail = lienMail(a.mail);
        return `<div class="dm-alert ${vu ? 'is-open' : ''}">
          <button type="button" class="dm-alert-row" data-alerte="${esc(a.id)}" aria-expanded="${vu}">
            <b>${esc(a.matiere || 'Cours')} · ${esc(d)}</b><span>${esc(a.titre)}</span></button>
          ${vu ? `<div class="dm-alert-body">${a.detail ? `<p>${esc(a.detail.length > 320 ? a.detail.slice(0, 319) + '…' : a.detail)}</p>` : ''}
            <div class="dm-actions">${a.quand ? `<button type="button" class="dm-btn" data-aller="${esc(a.quand)}">Voir ce jour-là</button>` : ''}
            ${mail ? `<a class="dm-btn" href="${esc(mail)}" target="_blank" rel="noopener noreferrer">Ouvrir le mail</a>` : ''}</div>
            <p class="dm-hint">Repéré dans le mail par mots-clés : à vérifier.</p></div>` : ''}
        </div>`;
      }).join('')}
    </section>`;
  }

  function vueSemaine(jours, t0) {
    const lundi = dateDe(jours[0]), dimanche = dateDe(jours[6]);
    const titre = lundi.getMonth() === dimanche.getMonth()
      ? `${lundi.getDate()} – ${dimanche.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`
      : `${lundi.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} – ${dimanche.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
    return `<div class="dm-week">
        <button type="button" class="dm-icon" data-semaine="-1" aria-label="Semaine précédente">${ICONE.gauche}</button>
        <button type="button" class="dm-week-title" data-semaine="0">${esc(titre)}${jours.includes(t0) ? '' : '<small>Revenir à aujourd’hui</small>'}</button>
        <button type="button" class="dm-icon" data-semaine="1" aria-label="Semaine suivante">${ICONE.droite}</button>
      </div>
      <div class="dm-strip">${jours.map(iso => {
        const d = dateDe(iso), a = AppState.tasks.filter(t => t.dueDate === iso && ouvert(t) && visible(t));
        const ev = a.some(evaluation);
        return `<button type="button" class="dm-day ${iso === jour ? 'is-current' : ''} ${iso === t0 ? 'is-today' : ''} ${iso < t0 ? 'is-past' : ''}" data-jour="${iso}">
          <span>${esc(d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', ''))}</span><b>${d.getDate()}</b>
          ${a.length ? `<em class="${ev ? 'is-eval' : ''}">${a.length}</em>` : '<em class="is-empty"></em>'}</button>`;
      }).join('')}</div>`;
  }

  function vueDevoirs(iso) {
    const taches = AppState.tasks.filter(t => t.dueDate === iso && visible(t)).sort(trier);
    if (!taches.length) return '<div class="dm-empty"><b>Rien à rendre</b>Profite de ta journée.</div>';
    const a = taches.filter(ouvert), f = taches.filter(t => !ouvert(t));
    return a.map(t => carte(t)).join('') + (f.length ? `<h4 class="dm-sub-h">Déjà validés</h4>${f.map(t => carte(t)).join('')}` : '');
  }

  function vueEmploi(iso, liste) {
    const evs = evenements(iso);
    const taches = AppState.tasks.filter(t => t.dueDate === iso && visible(t)).sort(trier);
    const cours = (evs || []).filter(e => !e.journee);
    const journee = (evs || []).filter(e => e.journee);
    const libres = [];
    for (const t of taches) {
      const k = matiere(t.course), tm = minutes(t.time);
      const tf = minutes(t.endTime) != null ? minutes(t.endTime) : (tm != null && creneau(t) ? tm + 60 : null);
      const memes = cours.filter(e => e.matiere === k);
      let hote = null;
      if (tm != null && tf != null) hote = memes.find(e => e.debut < tf && tm < e.fin) || null;
      else if (tm != null) hote = memes.find(e => tm >= e.debut && tm <= e.fin) || memes.filter(e => e.debut <= tm).pop() || memes[0] || null;
      else hote = memes[0] || null;
      if (hote) hote.devoirs.push(t);
      else if (tm != null && tf != null) cours.push({ tache: t, titre: t.title, debut: tm, fin: Math.max(tf, tm + 20), matiere: k, c: couleur(t.course), devoirs: [], alertes: [] });
      else libres.push(t);
    }
    for (const a of liste) if (a.dates.includes(iso)) cours.filter(e => e.matiere && e.matiere === a.matiere).forEach(e => e.alertes.push(a));
    cours.sort((a, b) => a.debut - b.debut || a.fin - b.fin);

    let html = evs === null ? `<p class="dm-note">${AppState.agenda ? 'L’emploi du temps partagé ne couvre pas ce jour.'
      : 'Les cours arrivent de l’app Calendrier du Mac de Louise : ouvre une fois l’app Dilou sur le Mac (vue Emploi du temps autorisée).'}</p>` : '';
    if (journee.length || libres.length) {
      html += `<h4 class="dm-sub-h">Dans la journée</h4>${journee.map(e => `<div class="dm-allday" style="--c:${e.c}"><i></i>${esc(e.titre)}</div>`).join('')}
        ${libres.map(t => carte(t, true)).join('')}`;
    }
    if (!cours.length) return html + (evs !== null && !journee.length && !libres.length ? '<div class="dm-empty"><b>Journée libre</b>Ni cours ni devoir.</div>' : '');
    const t0 = aujourdhui(), maintenant = new Date().getHours() * 60 + new Date().getMinutes();
    let repere = iso === t0;
    html += '<div class="dm-timeline">';
    for (const e of cours) {
      if (repere && e.debut > maintenant) { html += `<div class="dm-now"><span>${hhmm(maintenant)}</span></div>`; repere = false; }
      const ouverts = e.devoirs.filter(ouvert), passe = iso < t0 || (iso === t0 && e.fin <= maintenant);
      const t = e.tache;
      html += `<div class="dm-slot ${passe ? 'is-past' : ''}">
        <time>${hhmm(e.debut)}<small>${hhmm(Math.min(e.fin, 1439))}</small></time>
        <div class="dm-ev ${t ? 'is-task' : ''} ${t && evaluation(t) && ouvert(t) ? 'is-eval' : ''} ${e.alertes.length ? 'is-changed' : ''}" style="--c:${e.c}">
          ${e.devoirs.length ? `<b class="dm-badge ${ouverts.length ? '' : 'is-done'}">${ouverts.length || '✓'}</b>` : ''}
          ${t ? `<button type="button" class="dm-ev-title" data-deplier="${esc(t.id)}">${esc(t.course)} · ${esc(t.title)}</button>`
              : `<span class="dm-ev-title">${esc(e.titre)}</span>`}
          ${[e.lieu || (t && t.location), e.calendrier && !e.matiere ? e.calendrier : ''].filter(Boolean).length
            ? `<span class="dm-ev-meta">${esc([e.lieu || (t && t.location), e.calendrier && !e.matiere ? e.calendrier : ''].filter(Boolean).join(' · '))}</span>` : ''}
          ${e.alertes.length ? `<span class="dm-ev-warn">${ICONE.alerte}Changement signalé par mail</span>` : ''}
          ${t && deplies.has(t.id) ? carte(t, true) : ''}
          ${e.devoirs.map(d => deplies.has(d.id) ? carte(d, true)
            : `<button type="button" class="dm-ev-todo ${ouvert(d) ? '' : 'is-done'}" data-deplier="${esc(d.id)}"><span>${esc(d.title)}</span></button>`).join('')}
        </div></div>`;
    }
    if (repere) html += `<div class="dm-now"><span>${hhmm(maintenant)}</span></div>`;
    return html + '</div>';
  }

  function rendre() {
    if (!actif() || !pret() || Date.now() < pause) return;
    const vue = document.getElementById('calendarView');
    if (!vue) return;
    if (!racine || !racine.isConnected) {
      racine = document.createElement('section');
      racine.className = 'dm-cal';
      racine.setAttribute('aria-label', 'Calendrier');
      racine.addEventListener('click', surClic);
      vue.prepend(racine);
    }
    try {
      const lundi = new Date(AppState.calendarMonday), t0 = aujourdhui();
      const jours = [0, 1, 2, 3, 4, 5, 6].map(i => isoLocal(plus(lundi, i)));
      if (!jour || !jours.includes(jour)) jour = jours.includes(t0) ? t0 : jours[0];
      const liste = alertes();
      const d = dateDe(jour), ecart = Math.round((d - dateDe(t0)) / 86400000);
      const relatif = ecart === 0 ? 'Aujourd’hui' : ecart === 1 ? 'Demain' : ecart === -1 ? 'Hier' : '';
      racine.innerHTML = vueAlertes(liste)
        + `<div class="dm-mode" role="group" aria-label="Affichage">
            <button type="button" data-mode="devoirs" aria-pressed="${mode === 'devoirs'}">${ICONE.liste}Devoirs</button>
            <button type="button" data-mode="edt" aria-pressed="${mode === 'edt'}">${ICONE.horloge}Emploi du temps</button></div>`
        + vueSemaine(jours, t0)
        + `<h2 class="dm-day-title">${esc(maj(d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })))}${relatif ? `<small>${relatif}</small>` : ''}</h2>`
        + `<div class="dm-list">${mode === 'edt' ? vueEmploi(jour, liste) : vueDevoirs(jour)}</div>`;
    } catch (err) {
      console.warn('Dilou mobile :', err);
    }
  }
  const bientot = (() => { let f = 0; return () => { cancelAnimationFrame(f); f = requestAnimationFrame(rendre); }; })();

  function allerSemaine(date) {
    AppState.calendarMonday = mondayOfWeek(date);
    if (typeof renderCalendarView === 'function') renderCalendarView();
    bientot();
  }

  function surClic(e) {
    const b = e.target.closest('[data-mode], [data-semaine], [data-jour], [data-deplier], [data-sub], [data-valider], [data-alerte], [data-aller]');
    if (!b) return;
    if (b.dataset.mode) {
      mode = b.dataset.mode === 'edt' ? 'edt' : 'devoirs';
      try { localStorage.setItem(CLE_MODE, mode); } catch { /* rien */ }
      return rendre();
    }
    if (b.dataset.semaine) {
      const n = +b.dataset.semaine;
      if (n === 0) { jour = aujourdhui(); return allerSemaine(new Date()); }
      jour = null;
      return allerSemaine(plus(new Date(AppState.calendarMonday), 7 * n));
    }
    if (b.dataset.jour) { jour = b.dataset.jour; return rendre(); }
    if (b.dataset.aller) { jour = b.dataset.aller; return allerSemaine(dateDe(b.dataset.aller)); }
    if (b.dataset.alerte) {
      if (alertesOuvertes.has(b.dataset.alerte)) alertesOuvertes.delete(b.dataset.alerte); else alertesOuvertes.add(b.dataset.alerte);
      return rendre();
    }
    if (b.dataset.deplier) {
      if (deplies.has(b.dataset.deplier)) deplies.delete(b.dataset.deplier); else deplies.add(b.dataset.deplier);
      return rendre();
    }
    if (b.dataset.sub && typeof toggleSubtask === 'function') {
      // Retour immédiat : la case, le compteur et le liquide montent ; l'état réel suit
      b.classList.toggle('is-done');
      const c = b.closest('.dm-card');
      if (c) {
        const n = c.querySelectorAll('.dm-sub').length, f = c.querySelectorAll('.dm-sub.is-done').length;
        const liq = c.querySelector('.card-liquid-fill'), cpt = c.querySelector('.dm-count');
        if (liq && n) { liq.style.height = Math.round(f / n * 100) + '%'; liq.classList.toggle('is-visible', f > 0); }
        if (cpt) cpt.textContent = `${f}/${n}`;
      }
      pause = Date.now() + 900;
      toggleSubtask(b.dataset.tache, b.dataset.sub);
      return setTimeout(rendre, 950);
    }
    if (b.dataset.valider && typeof toggleValidateTask === 'function') {
      pause = Date.now() + 900;
      Promise.resolve(toggleValidateTask(b.dataset.valider)).finally(() => setTimeout(rendre, 950));
    }
  }

  // --- Mise en route ----------------------------------------------------------------------------------------------
  function appliquerEcran() {
    document.body.classList.toggle('dm-mobile', actif());
    if (actif()) rendre();
  }
  function demarrer() {
    appliquerEcran();
    ecran.addEventListener('change', appliquerEcran);
    const grille = document.getElementById('calendarWeekGrid');
    if (grille) new MutationObserver(bientot).observe(grille, { childList: true });
    const vue = document.getElementById('calendarView');
    if (vue) new MutationObserver(bientot).observe(vue, { attributes: true, attributeFilter: ['style'] });
    // Sur téléphone, la page s'ouvre directement sur le calendrier
    const ouvrirCalendrier = () => {
      if (!actif() || !pret() || !AppState.etatRecu) return false;
      if (AppState.currentView === 'active') { const onglet = document.getElementById('tabCalendar'); if (onglet) onglet.click(); }
      return true;
    };
    const essai = setInterval(() => { if (ouvrirCalendrier()) clearInterval(essai); }, 400);
    setTimeout(() => clearInterval(essai), 20000);
    // L'heure avance : la ligne « maintenant » et « Aujourd'hui » suivent
    setInterval(() => { if (actif() && mode === 'edt') rendre(); }, 5 * 60 * 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer);
  else demarrer();
})();
