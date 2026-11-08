/**
 * DILOU — CALENDRIER DES DEVOIRS UTC
 * Rendu, animations et interactions de la page. Les données passent toutes par donnees.js (Supabase).
 */

const D = window.DilouDonnees;

function mondayOfWeek(date) {
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

function isoLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function aujourdhuiIso(decalageJours = 0) {
  const d = new Date();
  d.setDate(d.getDate() + decalageJours);
  return isoLocal(d);
}

// État global de l'application
const AppState = {
  tasks: [],
  supervisionItems: [],
  robot: null,
  queue: null,
  currentView: 'active', // 'active' | 'calendar' | 'archived' | 'supervision'
  selectedCourse: 'ALL',
  calendarMonday: mondayOfWeek(new Date()),
  revision: null,
  isOnline: false,          // faux tant que le serveur n'a pas répondu : actions refusées, lecture seule
  derniereSynchro: null,    // dernier contact réussi avec le serveur
  dernierComplet: 0,        // dernier chargement complet (ms)
  copieDu: null,            // date de la copie locale affichée hors connexion
  tempsReel: false,
  etatRecu: false,          // un état (serveur ou copie) a été affiché : sinon « rien à faire » serait un mensonge
  echecConnexion: false,    // le dernier essai de joindre le serveur a échoué
  jourAffiche: aujourdhuiIso(),  // date du dernier rendu : au passage de minuit, tout est redessiné
};

// Copie du dernier état reçu du serveur : sert à annuler une action refusée sans attendre le réseau.
let copieServeur = new Map();

// Envois en cours : un rafraîchissement ne doit pas effacer ce que l'utilisateur vient de faire.
const COCHES_EN_COURS = new Map();        // « tâche␀exercice » → { tacheId, sousTacheId, voulu, enVol }
const VALIDATIONS_EN_COURS = new Map();   // tâche → true (valider) | false (rouvrir)
const ARBITRAGES_EN_COURS = new Set();    // éléments de supervision en cours d'envoi

// Incrémenté à chaque réponse d'action appliquée : un état lu pendant ce temps peut être plus ancien qu'elle.
let versionLocale = 0;

let activeSupervisionContext = null;
let brouillonId = null;          // identifiant du devoir en cours de saisie, fixé à l'ouverture de la modale
let ajoutEnCours = false;
let appDemarree = false;

const RECHARGE_COMPLETE_MS = 5 * 60 * 1000;  // l'état du robot change sans changer la révision
const VERIFICATION_MS = 30 * 1000;

function initApp() {
  D.prendreCleDansAdresse();
  setupEventListeners();
  setupLiaison();
  initVerticalScrollRuler();
  // Un lien « #cle=… » ouvert alors que la page est déjà là : même traitement qu'au chargement.
  window.addEventListener('hashchange', () => {
    const avant = D.cle();
    D.prendreCleDansAdresse();
    if (D.cle() && D.cle() !== avant) {
      AppState.revision = null;
      demarrer();
    }
  });
  if (!D.cle()) {
    montrerLiaison();
    return;
  }
  demarrer();
}

/**
 * Démarre (ou redémarre après liaison) : affiche la copie locale tout de suite, puis l'état du serveur.
 */
function demarrer(etatInitial = null) {
  cacherLiaison();
  if (etatInitial) {
    marquerEnLigne();
    appliquerEtat(etatInitial, false, true);
  } else {
    const cache = D.lireCache();
    if (cache) {
      AppState.copieDu = cache.enregistreLe || null;
      appliquerEtat(cache, true);
    } else {
      renderApp();
    }
    updateSyncBadge();
    demanderRafraichissement(true);
  }

  if (appDemarree) return;
  appDemarree = true;
  window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    verifierChangementDeJour();
    demanderRafraichissement(Date.now() - AppState.dernierComplet > RECHARGE_COMPLETE_MS || !AppState.isOnline);
  }, VERIFICATION_MS);
  window.addEventListener('focus', () => {
    verifierChangementDeJour();
    planifierRafraichissement(false, 150);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    verifierChangementDeJour();
    planifierRafraichissement(false, 150);
  });
  window.addEventListener('online', () => planifierRafraichissement(true, 300));
  window.addEventListener('offline', () => { AppState.isOnline = false; updateSyncBadge(); });
  brancherTempsReel();
  setTimeout(updateRulerScroll, 50);
}

/**
 * Temps réel (supabase-js, chargé en defer) : seulement un signal « quelque chose a changé ».
 * Si la bibliothèque n'a pas chargé, la vérification toutes les 30 s suffit.
 */
function brancherTempsReel() {
  const essayer = () => D.abonnerTempsReel(
    message => {
      // Notre propre modification revient aussi : inutile de recharger si la révision est déjà la nôtre.
      if (typeof message.revision === 'number' && message.revision === AppState.revision && !message.robot) return;
      planifierRafraichissement(true, 400);
    },
    statut => {
      const avant = AppState.tempsReel;
      AppState.tempsReel = statut === 'SUBSCRIBED';
      // (Re)connexion : rattraper ce qui a pu être manqué pendant la coupure.
      if (AppState.tempsReel && !avant) planifierRafraichissement(false, 200);
      updateSyncBadge();
    }
  );
  if (!essayer()) {
    document.addEventListener('DOMContentLoaded', essayer, { once: true });
    window.addEventListener('load', essayer, { once: true });
  }
}

/* --------------------------------------------------------------------------
   RAFRAÎCHISSEMENTS : regroupés, jamais deux en même temps
   -------------------------------------------------------------------------- */
let rafraichissementEnCours = null;
let rafraichirEncore = false;
let completDemande = false;
let minuterieRafraichissement = 0;

function planifierRafraichissement(complet, delai) {
  completDemande = completDemande || complet;
  window.clearTimeout(minuterieRafraichissement);
  minuterieRafraichissement = window.setTimeout(() => demanderRafraichissement(false), delai);
}

function demanderRafraichissement(complet = false) {
  completDemande = completDemande || complet;
  if (rafraichissementEnCours) {
    rafraichirEncore = true;
    return rafraichissementEnCours;
  }
  rafraichissementEnCours = (async () => {
    try {
      do {
        rafraichirEncore = false;
        const c = completDemande;
        completDemande = false;
        await rafraichirUneFois(c);
      } while (rafraichirEncore);
    } finally {
      rafraichissementEnCours = null;
    }
  })();
  return rafraichissementEnCours;
}

async function rafraichirUneFois(complet) {
  if (!D.cle()) return;
  try {
    if (!complet && AppState.isOnline && AppState.revision !== null) {
      const r = await D.revision();
      marquerEnLigne();
      if (r && r.revision === AppState.revision) {
        updateSyncBadge();
        return;
      }
    }
    const version = versionLocale;
    const etat = await D.etat();
    marquerEnLigne();
    if (version !== versionLocale) {
      // Une action a abouti pendant la lecture : cet état peut la précéder. On relit plutôt que d'effacer la coche.
      completDemande = true;
      rafraichirEncore = true;
      return;
    }
    AppState.dernierComplet = Date.now();
    appliquerEtat(etat, false);
    D.sauverCache({
      tasks: etat.tasks || [],
      supervision: etat.supervision || [],
      robot: etat.robot || null,
      queue: etat.queue || null,
      revision: etat.revision,
    });
    AppState.copieDu = null;
  } catch (err) {
    gererErreurServeur(err);
  }
}

function marquerEnLigne() {
  AppState.isOnline = true;
  AppState.echecConnexion = false;
  AppState.derniereSynchro = new Date();
  updateSyncBadge();
}

/**
 * Passage de minuit (page restée ouverte) : la bande « Aujourd'hui », la colonne du jour et les « Passé » dépendent
 * de la date, pas des données. Si on regardait la semaine du jour, on suit la nouvelle semaine.
 */
function verifierChangementDeJour() {
  if (aujourdhuiIso() === AppState.jourAffiche) return false;
  renderApp();
  updateRobotStatus();   // « à 14:30 » devient « hier à 14:30 »
  return true;
}

/** Appelé à chaque rendu complet : retient la date affichée et fait suivre la semaine du jour. */
function suivreLeJour() {
  const jour = aujourdhuiIso();
  if (jour === AppState.jourAffiche) return;
  const [a, m, j] = AppState.jourAffiche.split('-').map(Number);
  if (AppState.calendarMonday.getTime() === mondayOfWeek(new Date(a, m - 1, j)).getTime()) {
    AppState.calendarMonday = mondayOfWeek(new Date());
  }
  AppState.jourAffiche = jour;
}

function gererErreurServeur(err) {
  if (err && err.genre === 'cle') {
    if (D.oublierCle()) {
      // Clé d'un nouveau lien refusée : ce Mac garde la clé qui marchait.
      showToast('Lien refusé par le calendrier : ce Mac garde sa liaison actuelle.', true);
      AppState.revision = null;
      demanderRafraichissement(true);
      return;
    }
    // Clé révoquée ou inconnue : retour à l'écran de liaison, sans garder les devoirs affichés.
    AppState.isOnline = false;
    AppState.tasks = [];
    AppState.supervisionItems = [];
    AppState.etatRecu = false;
    copieServeur = new Map();
    renderApp();
    montrerLiaison('Clé refusée par le calendrier (mal copiée ou révoquée). Colle à nouveau le lien reçu de Victor.');
    return;
  }
  AppState.isOnline = false;
  const premierEchec = !AppState.echecConnexion;
  AppState.echecConnexion = true;
  // Rien à montrer : passer de « Chargement… » à « injoignable » (sans redessiner à chaque essai).
  if (!AppState.etatRecu && premierEchec) renderApp();
  updateSyncBadge();
}

/**
 * Remplace l'état affiché par celui du serveur, en gardant les actions encore en cours d'envoi.
 * Ne redessine que si quelque chose a réellement changé (pas de clignotement des cartes).
 */
function appliquerEtat(etat, depuisCache, forcer = false) {
  const avant = JSON.stringify([AppState.tasks, AppState.supervisionItems, AppState.agenda]);
  // Emploi du temps partagé par un Mac (app Calendrier), affiché par la vue mobile ; null s'il n'y en a pas
  AppState.agenda = etat.agenda && Array.isArray(etat.agenda.events) ? etat.agenda : null;
  const taches = Array.isArray(etat.tasks) ? etat.tasks.filter(t => t && t.status !== 'supprimee') : [];
  copieServeur = new Map(taches.map(t => [t.id, structuredClone(t)]));
  AppState.tasks = taches.map(t => appliquerEnvoisEnCours(structuredClone(t)));
  AppState.supervisionItems = (Array.isArray(etat.supervision) ? etat.supervision : [])
    .filter(it => it && it.status === 'pending' && !ARBITRAGES_EN_COURS.has(it.id));
  AppState.robot = etat.robot || null;
  AppState.queue = etat.queue || null;
  if (typeof etat.revision === 'number') AppState.revision = depuisCache ? null : etat.revision;
  const premier = !AppState.etatRecu;
  AppState.etatRecu = true;
  const apres = JSON.stringify([AppState.tasks, AppState.supervisionItems, AppState.agenda]);
  if (avant !== apres || depuisCache || forcer || premier) renderApp();
  else verifierChangementDeJour();   // mêmes données, mais peut-être plus le même jour
  updateRobotStatus();
}

function appliquerEnvoisEnCours(task) {
  for (const envoi of COCHES_EN_COURS.values()) {
    if (envoi.tacheId !== task.id) continue;
    const sub = (task.subtasks || []).find(st => st.id === envoi.sousTacheId);
    if (!sub) continue;
    sub.completed = envoi.voulu;
    if (!envoi.voulu && task.status === 'archived') {
      task.status = 'active';
      task.archivedAt = null;
    }
  }
  if (VALIDATIONS_EN_COURS.has(task.id)) {
    const archiver = VALIDATIONS_EN_COURS.get(task.id);
    task.status = archiver ? 'archived' : 'active';
    if (archiver) (task.subtasks || []).forEach(st => { st.completed = true; });
  }
  return task;
}

/** Une tâche renvoyée par le serveur après une action : on la range et on met l'affichage à jour. */
function remplacerTache(tacheServeur) {
  if (!tacheServeur || !tacheServeur.id) return null;
  versionLocale += 1;
  copieServeur.set(tacheServeur.id, structuredClone(tacheServeur));
  const nouvelle = appliquerEnvoisEnCours(structuredClone(tacheServeur));
  const i = AppState.tasks.findIndex(t => t.id === nouvelle.id);
  if (i >= 0) AppState.tasks[i] = nouvelle;
  else AppState.tasks.push(nouvelle);
  return nouvelle;
}

/** Action refusée : on revient à la dernière version connue du serveur pour cette tâche. */
function revenirAuServeur(taskId) {
  const copie = copieServeur.get(taskId);
  if (copie) remplacerTache(copie);
  renderApp();
}

/** Les modifications sont refusées hors connexion (lecture seule). */
function peutModifier() {
  if (AppState.isOnline) return true;
  showToast('Hors connexion : calendrier en lecture seule. Réessaie quand la connexion revient.', true);
  demanderRafraichissement(true);
  return false;
}

function signalerEchec(err, messageParDefaut) {
  if (err && err.genre === 'cle') {
    gererErreurServeur(err);
    return;
  }
  if (err && err.genre === 'reseau') {
    AppState.isOnline = false;
    updateSyncBadge();
    showToast(`${messageParDefaut} Connexion perdue : lecture seule.`, true);
    return;
  }
  showToast((err && err.message) || messageParDefaut, true);
  demanderRafraichissement(true);
}

/* --------------------------------------------------------------------------
   BADGES D'ÉTAT : synchronisation et robot
   -------------------------------------------------------------------------- */
function heureCourte(date) {
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function quandLisible(valeur) {
  if (!valeur) return null;
  const d = new Date(valeur);
  if (Number.isNaN(d.getTime())) return null;
  const heure = heureCourte(d);
  if (isoLocal(d) === aujourdhuiIso()) return `à ${heure}`;
  if (isoLocal(d) === aujourdhuiIso(-1)) return `hier à ${heure}`;
  return `le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} à ${heure}`;
}

function updateSyncBadge() {
  const badge = document.getElementById('syncStatusBadge');
  if (!badge) return;
  const text = badge.querySelector('.sync-text');
  if (!AppState.isOnline) {
    badge.dataset.state = 'offline';
    const copie = AppState.copieDu ? quandLisible(AppState.copieDu) : null;
    // « Connexion… » seulement avant le premier essai : dès un échec, on le dit.
    text.textContent = AppState.derniereSynchro || copie ? 'Hors connexion · lecture seule'
      : AppState.echecConnexion ? 'Hors connexion' : 'Connexion…';
    badge.title = copie ? `Copie locale enregistrée ${copie}` : 'Le calendrier n’est pas joignable pour le moment.';
    return;
  }
  badge.dataset.state = 'online';
  text.textContent = `Synchronisé · ${heureCourte(AppState.derniereSynchro || new Date())}`;
  badge.title = AppState.tempsReel
    ? 'Mis à jour en direct depuis tous les ordinateurs.'
    : 'Vérifié toutes les 30 secondes.';
}

const LECTURE_EN_RETARD_MS = 3 * 3600 * 1000;   // le robot passe toutes les heures (et à la demande)

/**
 * Ce que dit l'état du robot, sans toucher à la page (essayé par « tests/essai_page.sh logique »).
 * « Mails lus » vient de derniereLecture, écrit seulement quand la boîte a vraiment été lue : un passage qui saute
 * l'IMAP (identifiants absents) ne la rafraîchit pas. L'état est fusionné clé par clé, elle garde donc la vraie date.
 */
function decrireRobot(robot, queue, maintenant = Date.now()) {
  robot = robot || {};
  queue = queue || {};
  const pluriel = n => (n > 1 ? 's' : '');
  const enTri = (Number(queue.nouveau) || 0) + (Number(queue.enCours) || 0);
  const echecs = Number(queue.erreur) || 0;
  const passage = quandLisible(robot.quand);
  const lecture = quandLisible(robot.derniereLecture);
  const details = [];
  if (lecture) details.push(`Boîte UTC lue ${lecture}`);
  if (passage) details.push(`Dernier passage du robot ${passage}`);
  if (Number(robot.nouveaux) > 0) details.push(`${robot.nouveaux} nouveau(x) courriel(s) à ce passage`);
  if (echecs > 0) details.push(`${echecs} courriel(s) non trié(s) après plusieurs essais`);

  let etat = 'ok';
  let message;
  if (robot.erreur) {
    // Le robot écrit « IMAP : … ; tri : … » : on dit ce qui manque vraiment à Louise.
    const erreur = String(robot.erreur);
    const imap = /(^|;\s*)IMAP :/.test(erreur);
    const tri = /(^|;\s*)tri :/.test(erreur);
    etat = 'alerte';
    message = imap ? 'Robot en panne · mails non lus'
      : tri ? 'Tri en panne · mails lus mais non triés'
      : 'Robot en panne';
    details.unshift(`Erreur : ${erreur.slice(0, 300)}`);
  } else if (enTri > 0) {
    message = `${enTri} mail${pluriel(enTri)} en cours de tri`;
    if (echecs > 0) {
      etat = 'attente';
      message += ` · ${echecs} non trié${pluriel(echecs)}`;
    }
  } else if (echecs > 0) {
    etat = 'attente';
    message = `${echecs} mail${pluriel(echecs)} non trié${pluriel(echecs)}`;
  } else if (lecture) {
    if (maintenant - new Date(robot.derniereLecture).getTime() > LECTURE_EN_RETARD_MS) {
      etat = 'attente';
      message = `Dernière lecture des mails ${lecture}`;
    } else {
      message = `Mails lus ${lecture}`;
    }
  } else if (passage) {
    etat = 'attente';
    message = 'Boîte UTC pas encore lue';
  } else {
    etat = 'attente';
    message = 'Robot pas encore passé';
  }
  return { etat, message, details: details.join('\n') || 'Le robot lit la boîte UTC toutes les heures, et tout de suite avec « Actualiser ».' };
}

function updateRobotStatus() {
  const box = document.getElementById('robotStatus');
  if (!box) return;
  const d = decrireRobot(AppState.robot, AppState.queue);
  box.dataset.state = d.etat;
  box.querySelector('.robot-text').textContent = d.message;
  box.title = d.details;
}

/* --------------------------------------------------------------------------
   ÉCRAN DE LIAISON : ce Mac n'a pas (ou plus) de clé d'accès
   -------------------------------------------------------------------------- */
function setupLiaison() {
  const form = document.getElementById('formLiaison');
  const champ = document.getElementById('champLiaison');
  const message = document.getElementById('messageLiaison');
  const bouton = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cle = D.extraireCle(champ.value);
    if (!cle) {
      message.textContent = 'Lien ou clé non reconnu. Copie le lien complet reçu de Victor.';
      message.dataset.state = 'erreur';
      return;
    }
    bouton.disabled = true;
    message.textContent = 'Vérification…';
    message.dataset.state = '';
    try {
      const etat = await D.essayerCle(cle);
      D.enregistrerCle(cle);
      champ.value = '';
      message.textContent = '';
      demarrer(etat);
      D.sauverCache({ tasks: etat.tasks || [], supervision: etat.supervision || [], robot: etat.robot || null,
                      queue: etat.queue || null, revision: etat.revision });
      AppState.dernierComplet = Date.now();
      showToast('Ce Mac est relié au calendrier.');
    } catch (err) {
      message.dataset.state = 'erreur';
      message.textContent = err && err.genre === 'cle'
        ? 'Cette clé est refusée (mal copiée ou révoquée). Demande un nouveau lien à Victor.'
        : 'Calendrier injoignable pour le moment. Vérifie la connexion puis réessaie.';
    } finally {
      bouton.disabled = false;
    }
  });
}

function montrerLiaison(texte = '') {
  const ecran = document.getElementById('ecranLiaison');
  const message = document.getElementById('messageLiaison');
  ecran.hidden = false;
  document.body.classList.add('is-liaison');
  message.textContent = texte;
  message.dataset.state = texte ? 'erreur' : '';
  setTimeout(() => document.getElementById('champLiaison').focus(), 50);
}

function cacherLiaison() {
  document.getElementById('ecranLiaison').hidden = true;
  document.body.classList.remove('is-liaison');
}

/**
 * Configuration des écouteurs d'événements
 */
function setupEventListeners() {
  // Changement de vue (Tous les devoirs / Calendrier / Archives / Supervision)
  const tabActive = document.getElementById('tabActive');
  const tabCalendar = document.getElementById('tabCalendar');
  const tabArchived = document.getElementById('tabArchived');
  const tabSupervision = document.getElementById('tabSupervision');

  tabActive.addEventListener('click', () => switchView('active'));
  tabCalendar.addEventListener('click', () => switchView('calendar'));
  tabArchived.addEventListener('click', () => switchView('archived'));
  if (tabSupervision) {
    tabSupervision.addEventListener('click', () => switchView('supervision'));
  }

  // Navigation dans le calendrier par semaine
  document.getElementById('btnPrevWeek').addEventListener('click', () => {
    AppState.calendarMonday.setDate(AppState.calendarMonday.getDate() - 7);
    renderCalendarView();
  });

  document.getElementById('btnNextWeek').addEventListener('click', () => {
    AppState.calendarMonday.setDate(AppState.calendarMonday.getDate() + 7);
    renderCalendarView();
  });

  document.getElementById('btnCurrentWeek').addEventListener('click', () => {
    AppState.calendarMonday = mondayOfWeek(new Date());
    renderCalendarView();
  });

  // Filtres par matière
  const filterPills = document.querySelectorAll('.filter-pill');
  filterPills.forEach(pill => {
    pill.addEventListener('click', (e) => {
      filterPills.forEach(p => p.classList.remove('is-active'));
      const target = e.currentTarget;
      target.classList.add('is-active');
      AppState.selectedCourse = target.getAttribute('data-course');

      if (AppState.currentView === 'calendar') {
        renderCalendarView();
      } else {
        renderTaskList();
      }
    });
  });

  // Modal d'ajout de devoir
  const btnOpenModal = document.getElementById('btnOpenAddModal');
  const modalBackdrop = document.getElementById('addModal');
  const btnCloseModal = document.getElementById('btnCloseModal');
  const btnCancelModal = document.getElementById('btnCancelModal');
  const formAdd = document.getElementById('addHomeworkForm');
  const btnAddSubtaskRow = document.getElementById('btnAddSubtaskRow');

  btnOpenModal.addEventListener('click', () => {
    activeSupervisionContext = null;
    ouvrirModale();
    document.getElementById('taskDueDate').value = aujourdhuiIso();
  });

  const closeModal = () => {
    modalBackdrop.classList.remove('is-open');
    formAdd.reset();
    reinitialiserExercices();
    activeSupervisionContext = null;
  };

  btnCloseModal.addEventListener('click', closeModal);
  btnCancelModal.addEventListener('click', closeModal);

  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalBackdrop.classList.contains('is-open')) closeModal();
  });

  // Ajout dynamique de ligne d'exercice
  btnAddSubtaskRow.addEventListener('click', () => {
    const list = document.getElementById('subtasksInputList');
    const row = creerLigneExercice(`Ex: Exercice ${list.children.length + 1}`);
    list.appendChild(row);
    row.querySelector('input').focus();
  });
  document.querySelectorAll('#subtasksInputList .btn-remove-subtask').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.subtask-row').remove());
  });

  // Soumission du formulaire d'ajout
  formAdd.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ajoutEnCours) return;   // double clic : un seul envoi
    if (!peutModifier()) return;

    const title = document.getElementById('taskTitle').value.trim();
    const course = document.getElementById('taskCourse').value;
    const kind = document.getElementById('taskKind').value;
    const dueDate = document.getElementById('taskDueDate').value;
    const dueDisplay = document.getElementById('taskDue').value.trim();
    const time = document.getElementById('taskTime').value;
    const endTime = document.getElementById('taskEndTime').value;
    const location = document.getElementById('taskLocation').value.trim();
    const notes = document.getElementById('taskNotes').value.trim();
    if (!title) return;

    const subtasks = [];
    document.querySelectorAll('.input-subtask').forEach(inp => {
      const val = inp.value.trim();
      if (val) subtasks.push({ title: val });
    });

    const ctx = activeSupervisionContext;
    // L'identifiant est fixé à l'ouverture de la modale : une nouvelle tentative ne crée pas de doublon.
    if (!brouillonId) brouillonId = D.nouvelIdentifiant();
    const newTask = {
      id: brouillonId,
      course,
      courseName: getCourseName(course),
      title,
      dueDate: dueDate || '',
      dueDisplay: dueDisplay || formatDateDisplay(dueDate),
      time: time || null,
      endTime: endTime || null,
      location: location || null,
      kind,
      isEvaluation: kind === 'evaluation',
      priority: kind === 'evaluation' ? 'urgent' : 'normal',
      notes,
      subtasks,
      emailUid: ctx ? ctx.emailUid : null,
      emailSubject: ctx ? ctx.emailSubject : null,
      emailSender: ctx ? ctx.emailSender : null,
      emailDate: ctx ? ctx.emailDate : null,
      emailUrl: ctx ? safeEmailUrl(ctx.emailUrl) : null,
    };

    const boutonEnvoi = formAdd.querySelector('button[type="submit"]');
    ajoutEnCours = true;
    boutonEnvoi.disabled = true;
    boutonEnvoi.textContent = 'Enregistrement…';
    try {
      const data = await D.ajouterTache(newTask, ctx ? ctx.id : null);
      const cree = remplacerTache(data && data.task);
      if (ctx) {
        AppState.supervisionItems = AppState.supervisionItems.filter(it => it.id !== ctx.id);
      }
      brouillonId = null;
      closeModal();
      renderApp();
      showToast(ctx
        ? `Devoir créé à partir du courriel « ${ctx.emailSubject || ctx.suggestedTitle || ''} ».`
        : `Devoir « ${(cree && cree.title) || title} » ajouté.`);
    } catch (err) {
      // On garde la saisie et le même identifiant : « Enregistrer » à nouveau ne créera pas de doublon.
      signalerEchec(err, 'Le devoir n’a pas été enregistré.');
    } finally {
      ajoutEnCours = false;
      boutonEnvoi.disabled = false;
      boutonEnvoi.textContent = 'Enregistrer le devoir';
    }
  });

  // Actualiser à la demande : recharge le calendrier et demande au robot de lire la boîte UTC tout de suite (la base
  // n'accepte qu'une demande toutes les 10 minutes). La fin du passage arrive par le temps réel ; recharge de secours.
  const btnRefresh = document.getElementById('btnRefresh');
  btnRefresh.addEventListener('click', async () => {
    await demanderRafraichissement(true);
    if (!AppState.isOnline) {
      showToast('Calendrier injoignable : copie locale affichée.', true);
      return;
    }
    let message = 'Calendrier actualisé.';
    try {
      const rep = await D.demanderPassage();
      if (rep && rep.lance) {
        message = 'Calendrier actualisé · lecture des mails lancée, résultat dans une minute environ.';
        window.setTimeout(() => demanderRafraichissement(true), 120 * 1000);
      } else if (rep && rep.raison === 'recent') {
        message = `Calendrier actualisé · mails déjà demandés ${quandLisible(rep.depuis) || 'à l’instant'}, `
          + `nouvelle demande possible ${quandLisible(rep.prochain) || 'bientôt'}.`;
      }
    } catch (err) {
      message = 'Calendrier actualisé (lecture des mails à la demande indisponible).';
    }
    showToast(message);
  });
}

function ouvrirModale() {
  const formAdd = document.getElementById('addHomeworkForm');
  formAdd.reset();
  reinitialiserExercices();
  brouillonId = D.nouvelIdentifiant();
  document.getElementById('addModal').classList.add('is-open');
  setTimeout(() => document.getElementById('taskTitle').focus(), 60);
}

function creerLigneExercice(placeholder) {
  const row = document.createElement('div');
  row.className = 'subtask-row';
  row.innerHTML = `
    <input type="text" class="input-subtask" placeholder="${escapeHtml(placeholder)}">
    <button type="button" class="btn-remove-subtask" title="Supprimer">✕</button>
  `;
  row.querySelector('.btn-remove-subtask').addEventListener('click', () => row.remove());
  return row;
}

function reinitialiserExercices(placeholder = 'Ex: Exercice 1') {
  const list = document.getElementById('subtasksInputList');
  list.innerHTML = '';
  list.appendChild(creerLigneExercice(placeholder));
}

/**
 * ============================================================================
 * RÈGLE DE DÉFILEMENT VERTICALE MOTION STUDIO (SCROLL RULER)
 * Inspirée du portfolio Victor Studio
 * ============================================================================
 */
let updateRulerScroll = () => {};

function initVerticalScrollRuler() {
  const ruler = document.getElementById('verticalScrollRuler');
  const track = document.getElementById('verticalRulerTrack');
  const playhead = document.getElementById('rulerPlayhead');
  const pctFill = document.getElementById('playheadPctFill');
  const pctBase = document.getElementById('playheadPctBase');
  const pctCovered = document.getElementById('playheadPctCovered');
  const sectionLabel = document.getElementById('playheadSection');
  const anchorButtons = document.querySelectorAll('.ruler-anchor-point');

  if (!ruler || !track || !playhead) return;

  let isScrollingTimer = 0;
  let animFrame = 0;

  updateRulerScroll = () => {
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const currentScroll = window.scrollY;
    let progress = 0;
    if (docHeight > 0) {
      progress = Math.min(100, Math.max(0, (currentScroll / docHeight) * 100));
    }

    // Positionnement de la tête de lecture le long de la règle
    playhead.style.top = `${progress}%`;

    // Jauge de remplissage rouge dynamique
    if (pctFill) pctFill.style.width = `${progress}%`;

    const roundedPct = Math.round(progress);
    if (pctBase) pctBase.textContent = `${roundedPct}%`;
    if (pctCovered) {
      pctCovered.textContent = `${roundedPct}%`;
      pctCovered.style.clipPath = `inset(0 ${Math.max(0, 100 - progress)}% 0 0)`;
    }

    // Section active selon la position de défilement ou la vue courante
    let currentSection = 'INTRO';
    if (currentScroll > 60) {
      switch (AppState.currentView) {
        case 'active':
          currentSection = 'DEVOIRS';
          break;
        case 'calendar':
          currentSection = 'CALENDRIER';
          break;
        case 'supervision':
          currentSection = 'SUPERVISION';
          break;
        case 'archived':
          currentSection = 'ARCHIVES';
          break;
        default:
          currentSection = 'DEVOIRS';
      }
    } else {
      currentSection = 'INTRO';
    }

    if (sectionLabel) {
      sectionLabel.textContent = currentSection;
    }

    // Mise à jour de l'ancre active (point rouge avec aura)
    anchorButtons.forEach(btn => {
      const target = btn.getAttribute('data-ruler-target');
      let isActive = false;
      if (target === 'top' && currentSection === 'INTRO') {
        isActive = true;
      } else if (target === 'devoirs' && currentSection === 'DEVOIRS') {
        isActive = true;
      } else if (target === 'calendar' && currentSection === 'CALENDRIER') {
        isActive = true;
      } else if (target === 'supervision' && currentSection === 'SUPERVISION') {
        isActive = true;
      } else if (target === 'archives' && currentSection === 'ARCHIVES') {
        isActive = true;
      }
      btn.classList.toggle('is-active', isActive);
    });
  };

  // Écoute du défilement avec animation fluide et classe 'is-scrolling'
  const onScrollHandler = () => {
    ruler.classList.add('is-scrolling');
    window.clearTimeout(isScrollingTimer);
    isScrollingTimer = window.setTimeout(() => {
      ruler.classList.remove('is-scrolling');
    }, 1200);

    if (!animFrame) {
      animFrame = requestAnimationFrame(() => {
        updateRulerScroll();
        animFrame = 0;
      });
    }
  };

  window.addEventListener('scroll', onScrollHandler, { passive: true });
  window.addEventListener('resize', onScrollHandler, { passive: true });

  // Clic sur la règle pour défilement proportionnel direct
  track.addEventListener('click', (e) => {
    // Si le clic provient d'une ancre, elle gère déjà son propre clic
    if (e.target.closest('.ruler-anchor-point')) return;

    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const ratio = Math.max(0, Math.min(1, clickY / rect.height));
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const targetScroll = ratio * docHeight;

    window.scrollTo({
      top: targetScroll,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    });
  });

  // Clic sur les ancres de navigation
  anchorButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = btn.getAttribute('data-ruler-target');
      if (target === 'top') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (target === 'devoirs') {
        if (AppState.currentView !== 'active') {
          switchView('active');
        }
        const tasksGrid = document.getElementById('tasksGrid');
        if (tasksGrid) {
          tasksGrid.scrollIntoView({ behavior: 'smooth' });
        }
      } else if (target === 'calendar') {
        if (AppState.currentView !== 'calendar') {
          switchView('calendar');
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (target === 'supervision') {
        if (AppState.currentView !== 'supervision') {
          switchView('supervision');
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (target === 'archives') {
        if (AppState.currentView !== 'archived') {
          switchView('archived');
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      setTimeout(updateRulerScroll, 100);
    });
  });

  // Mise à jour immédiate
  updateRulerScroll();
}

function switchView(viewName) {
  AppState.currentView = viewName;
  suivreLeJour();
  updateSansDonnees();

  const tabActive = document.getElementById('tabActive');
  const tabCalendar = document.getElementById('tabCalendar');
  const tabArchived = document.getElementById('tabArchived');
  const tabSupervision = document.getElementById('tabSupervision');

  tabActive.classList.toggle('is-active', viewName === 'active');
  tabActive.setAttribute('aria-selected', viewName === 'active');
  tabCalendar.classList.toggle('is-active', viewName === 'calendar');
  tabCalendar.setAttribute('aria-selected', viewName === 'calendar');
  tabArchived.classList.toggle('is-active', viewName === 'archived');
  tabArchived.setAttribute('aria-selected', viewName === 'archived');
  if (tabSupervision) {
    tabSupervision.classList.toggle('is-active', viewName === 'supervision');
    tabSupervision.setAttribute('aria-selected', viewName === 'supervision');
  }

  const titleElem = document.getElementById('viewTitle');
  const subElem = document.getElementById('viewSubtitle');
  const tasksGrid = document.getElementById('tasksGrid');
  const calendarView = document.getElementById('calendarView');
  const supervisionView = document.getElementById('supervisionView');
  const emptyState = document.getElementById('emptyState');
  const sectionHeader = document.getElementById('sectionHeader');
  const todayStrip = document.getElementById('todayStrip');

  todayStrip.style.display = 'none';
  if (viewName === 'calendar') {
    sectionHeader.style.display = 'none';
    tasksGrid.style.display = 'none';
    if (supervisionView) supervisionView.style.display = 'none';
    calendarView.style.display = 'flex';
    emptyState.style.display = 'none';
    renderCalendarView();
  } else if (viewName === 'supervision') {
    sectionHeader.style.display = 'none';
    tasksGrid.style.display = 'none';
    calendarView.style.display = 'none';
    emptyState.style.display = 'none';
    if (supervisionView) supervisionView.style.display = 'block';
    renderSupervisionView();
  } else {
    if (supervisionView) supervisionView.style.display = 'none';
    sectionHeader.style.display = 'block';
    tasksGrid.style.display = 'grid';
    calendarView.style.display = 'none';

    if (viewName === 'active') {
      titleElem.textContent = "Devoirs & Exercices en cours";
      subElem.textContent = "Sélectionnez les exercices traités ou validez le devoir complet pour l'archiver.";
    } else {
      titleElem.textContent = "Archives des devoirs validés";
      subElem.textContent = "Historique des devoirs et exercices terminés avec succès.";
    }

    renderTaskList();
  }
  setTimeout(updateRulerScroll, 50);
}

/**
 * Rendu complet de l'application
 */
function renderApp() {
  suivreLeJour();
  updateSansDonnees();
  updateMetrics();
  updateSupervisionBadge();
  if (AppState.currentView === 'calendar') {
    renderCalendarView();
  } else if (AppState.currentView === 'supervision') {
    renderSupervisionView();
  } else {
    renderTaskList();
  }
  setTimeout(updateRulerScroll, 50);
}

/** Bandeau affiché tant qu'aucun état n'a été reçu (premier passage hors connexion, copie effacée…). */
function updateSansDonnees() {
  const bloc = document.getElementById('sansDonnees');
  if (!bloc) return;
  bloc.hidden = AppState.etatRecu;
  if (AppState.etatRecu) return;
  const titre = document.getElementById('sansDonneesTitre');
  const texte = document.getElementById('sansDonneesTexte');
  if (AppState.echecConnexion) {
    titre.textContent = 'Calendrier injoignable · aucune copie sur ce Mac';
    texte.textContent = 'Les devoirs ne peuvent pas être affichés pour le moment. La page réessaie toute seule ; vérifie la connexion.';
  } else {
    titre.textContent = 'Chargement du calendrier…';
    texte.textContent = '';
  }
}

/* --------------------------------------------------------------------------
   OUTILS DE PRÉSENTATION
   -------------------------------------------------------------------------- */
const MATIERES_PRINCIPALES = ['LA21', 'MT03', 'MT02', 'PS21', 'IS00', 'GE28', 'NP90', 'PS90'];

function correspondFiltre(task) {
  const choix = AppState.selectedCourse;
  if (choix === 'ALL') return true;
  const c = String(task.course || '').toUpperCase();
  if (choix === 'NP90') return c === 'NP90' || c === 'PS90';
  if (choix === 'CAMPUS') return !MATIERES_PRINCIPALES.includes(c);   // campus, scolarité et le reste
  return c === choix;
}

function comparerTaches(a, b) {
  const da = a.dueDate || '9999-12-31';
  const db = b.dueDate || '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  const ha = a.time || '99:99';
  const hb = b.time || '99:99';
  if (ha !== hb) return ha < hb ? -1 : 1;
  return String(a.title || '').localeCompare(String(b.title || ''), 'fr');
}

function estEvaluation(task) {
  if (task.kind === 'evaluation' || task.isEvaluation === true) return true;
  const titre = String(task.title || '').toUpperCase();
  return titre.includes('ÉVALUATION') || titre.includes('EVALUATION');
}

/** Événements et rendez-vous : des créneaux, sans exercice, mais validables. */
function estCreneau(task) {
  return task.kind === 'evenement' || task.kind === 'rdv';
}

function libelleGenre(task) {
  if (task.kind === 'rdv') return 'RDV';
  if (task.kind === 'evenement') return 'ÉVÉNEMENT';
  return '';
}

function horaire(task) {
  if (!task.time) return '';
  return task.endTime ? `${task.time}–${task.endTime}` : task.time;
}

function classeMatiere(course) {
  return `badge-${String(course || 'autre').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

function formatHorodatage(valeur) {
  if (!valeur) return 'Récemment';
  const d = new Date(valeur);
  if (Number.isNaN(d.getTime())) return String(valeur).substring(0, 16);
  return `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} à ${heureCourte(d)}`;
}

const ICONE_LIEU = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"></path><circle cx="12" cy="9.5" r="2.5"></circle></svg>';

/**
 * Met à jour les compteurs et la jauge de progression
 */
function updateMetrics() {
  const activeTasks = AppState.tasks.filter(t => t.status !== 'archived');
  const archivedTasks = AppState.tasks.filter(t => t.status === 'archived');

  document.getElementById('countActive').textContent = activeTasks.length;
  document.getElementById('countArchived').textContent = archivedTasks.length;

  let totalSubtasks = 0;
  let completedSubtasks = 0;

  activeTasks.forEach(t => {
    const list = t.subtasks || [];
    totalSubtasks += list.length;
    completedSubtasks += list.filter(st => st.completed).length;
  });

  const percent = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;

  document.getElementById('subtaskProgressRatio').textContent = `${completedSubtasks} / ${totalSubtasks}`;
  document.getElementById('subtaskProgressPercent').textContent = `(${percent}%)`;
  document.getElementById('progressBar').style.width = `${percent}%`;
}

/**
 * Bande « Aujourd'hui » : dû aujourd'hui et demain, évaluations des 7 prochains jours.
 */
function renderTodayStrip() {
  const strip = document.getElementById('todayStrip');
  if (AppState.currentView !== 'active' || !AppState.etatRecu) {
    strip.style.display = 'none';
    return;
  }
  const jour = aujourdhuiIso();
  const demain = aujourdhuiIso(1);
  const limite = aujourdhuiIso(7);
  const actives = AppState.tasks.filter(t => t.status !== 'archived' && correspondFiltre(t)).sort(comparerTaches);
  const colonnes = [
    { titre: "Aujourd'hui", date: formatDateDisplay(jour), items: actives.filter(t => t.dueDate === jour) },
    { titre: 'Demain', date: formatDateDisplay(demain), items: actives.filter(t => t.dueDate === demain) },
    { titre: 'Évaluations', date: `jusqu'au ${formatDateDisplay(limite)}`, avecDate: true,
      items: actives.filter(t => estEvaluation(t) && t.dueDate > demain && t.dueDate <= limite) },
  ];

  strip.style.display = 'grid';
  strip.innerHTML = colonnes.map(col => `
    <div class="today-col">
      <div class="today-col-head">
        <span class="today-col-title">${escapeHtml(col.titre)}</span>
        <span class="today-col-date">${escapeHtml(col.date)}</span>
      </div>
      ${col.items.length === 0 ? '<p class="today-empty">Rien de prévu</p>' : `
      <ul class="today-list">
        ${col.items.map(t => {
          const done = (t.subtasks || []).filter(st => st.completed).length;
          const total = (t.subtasks || []).length;
          const quand = [col.avecDate ? formatDateDisplay(t.dueDate) : '', horaire(t)].filter(Boolean);
          return `
          <li>
            <button type="button" class="today-item ${estEvaluation(t) ? 'is-evaluation' : ''}" data-task-id="${escapeHtml(t.id)}">
              <span class="today-time">${quand.length ? quand.map(q => `<span>${escapeHtml(q)}</span>`).join('') : '—'}</span>
              <span class="course-badge ${classeMatiere(t.course)}">${escapeHtml(t.course)}</span>
              <span class="today-title">${escapeHtml(t.title)}</span>
              ${t.location ? `<span class="today-where">${ICONE_LIEU}${escapeHtml(t.location)}</span>` : ''}
              ${total > 0 ? `<span class="today-progress">${done}/${total}</span>` : ''}
            </button>
          </li>`;
        }).join('')}
      </ul>`}
    </div>
  `).join('');

  strip.querySelectorAll('.today-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = document.getElementById(`card-${btn.getAttribute('data-task-id')}`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('is-reperee');
      void card.offsetWidth;   // relancer l'animation de repérage
      card.classList.add('is-reperee');
    });
  });
}

/**
 * Rendu de la grille des devoirs (Liste / Grille)
 */
function renderTaskList() {
  const container = document.getElementById('tasksGrid');
  const emptyState = document.getElementById('emptyState');
  container.innerHTML = '';
  renderTodayStrip();

  let filtered = AppState.tasks.filter(t => {
    return AppState.currentView === 'active' ? t.status !== 'archived' : t.status === 'archived';
  });
  filtered = filtered.filter(correspondFiltre).sort(comparerTaches);
  if (AppState.currentView === 'archived') filtered.reverse();   // les plus récents d'abord

  if (filtered.length === 0) {
    // « Tout est à jour » seulement si on sait vraiment ce qu'il y a à faire.
    emptyState.style.display = AppState.etatRecu ? 'block' : 'none';
    return;
  } else {
    emptyState.style.display = 'none';
  }

  filtered.forEach(task => {
    const card = createTaskCardElement(task);
    container.appendChild(card);
  });
}

/**
 * Rendu de la vue Calendrier par Semaine
 */
function renderCalendarView() {
  const grid = document.getElementById('calendarWeekGrid');
  const weekLabel = document.getElementById('calendarWeekLabel');
  const weekSub = document.getElementById('calendarWeekSub');
  grid.innerHTML = '';

  // Calcul des 7 jours de la semaine (du Lundi au Dimanche)
  const monday = new Date(AppState.calendarMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const monthsFr = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const daysFr = ["LUN", "MAR", "MER", "JEU", "VEN", "SAM", "DIM"];

  // Libellé de la semaine
  if (monday.getMonth() === sunday.getMonth()) {
    weekLabel.textContent = `Semaine du ${monday.getDate()} au ${sunday.getDate()} ${monthsFr[monday.getMonth()]} ${monday.getFullYear()}`;
  } else {
    weekLabel.textContent = `Semaine du ${monday.getDate()} ${monthsFr[monday.getMonth()]} au ${sunday.getDate()} ${monthsFr[sunday.getMonth()]} ${sunday.getFullYear()}`;
  }
  if (weekSub) {
    const ecart = Math.round((monday - mondayOfWeek(new Date())) / (7 * 24 * 3600 * 1000));
    weekSub.textContent = ecart === 0 ? 'Cette semaine'
      : ecart === 1 ? 'Semaine prochaine'
      : ecart === -1 ? 'Semaine dernière'
      : ecart > 0 ? `Dans ${ecart} semaines` : `Il y a ${-ecart} semaines`;
  }

  // Date locale actuelle (pour le badge "Aujourd'hui")
  const todayStr = aujourdhuiIso();

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateIso = isoLocal(d);

    const isToday = dateIso === todayStr;
    const isPast = dateIso < todayStr;
    const isWeekend = i >= 5;

    const col = document.createElement('div');
    col.className = `calendar-day-col ${isToday ? 'is-today' : ''} ${isPast ? 'is-past' : ''} ${isWeekend ? 'is-weekend' : ''}`;

    // Header du jour
    col.innerHTML = `
      <div class="calendar-day-header">
        <div class="day-header-left">
          <span class="day-name">${daysFr[i]}</span>
          <span class="day-number">${d.getDate()}</span>
        </div>
        ${isToday ? '<span class="today-dot" title="Aujourd\'hui"></span>' : (isPast ? '<span class="past-day-badge" title="Jour déjà passé">Passé</span>' : '')}
      </div>
      <div class="calendar-day-tasks"></div>
    `;

    grid.appendChild(col);

    // Tâches assignées à ce jour, dans l'ordre des heures
    const tasksForDay = AppState.tasks
      .filter(t => t.dueDate === dateIso && correspondFiltre(t))
      .sort(comparerTaches);

    const tasksContainer = col.querySelector('.calendar-day-tasks');

    if (tasksForDay.length === 0) {
      tasksContainer.innerHTML = `<div class="cal-empty-day">${AppState.etatRecu ? 'Aucun devoir' : '—'}</div>`;
    } else {
      tasksForDay.forEach(t => {
        const calCard = createCalendarTaskCard(t);
        tasksContainer.appendChild(calCard);
      });
    }
  }
}

/**
 * Génère le balisage SVG du liquide et des vagues animées
 * Le liquide est un SVG unique et continu : zéro démarcation, zéro couture verticale
 */
function getLiquidFillHTML(percent = 0) {
  const isVisible = percent > 0;
  return `
    <div class="card-liquid-fill ${isVisible ? 'is-visible' : ''}" style="height: ${percent}%;">
      <div class="liquid-wave-track is-back">
        <svg class="liquid-wave-svg" viewBox="0 0 2000 400" preserveAspectRatio="none">
          <path d="M 0 25 Q 250 45 500 25 T 1000 25 T 1500 25 T 2000 25 L 2000 400 L 0 400 Z"></path>
        </svg>
      </div>
      <div class="liquid-wave-track">
        <svg class="liquid-wave-svg" viewBox="0 0 2000 400" preserveAspectRatio="none">
          <path d="M 0 25 Q 250 5 500 25 T 1000 25 T 1500 25 T 2000 25 L 2000 400 L 0 400 Z"></path>
        </svg>
      </div>
    </div>
  `;
}

function libelleProgression(task, doneCount, total) {
  if (total === 0 && estCreneau(task)) return 'Créneau';
  return `${doneCount}/${total} fait(s)`;
}

/**
 * Crée une carte de tâche compacte pour la vue calendrier avec bullet points interactifs
 * Reste toujours visible dans le calendrier même une fois validée (toute verte)
 */
function createCalendarTaskCard(task) {
  const card = document.createElement('div');
  const isValidated = task.status === 'archived';
  const isEval = estEvaluation(task);
  const isPast = Boolean(task.dueDate && task.dueDate < aujourdhuiIso());

  card.className = `cal-task-card ${isValidated ? 'is-validated' : ''} ${isEval && !isValidated ? 'is-evaluation' : ''} ${isPast ? 'is-past-due' : ''} ${estCreneau(task) ? 'is-creneau' : ''}`;
  card.id = `cal-card-${task.id}`;

  const subtasks = task.subtasks || [];
  const doneCount = subtasks.filter(st => st.completed).length;
  const isFullyDone = subtasks.length > 0 && doneCount === subtasks.length;

  // Calcul du pourcentage de remplissage liquide
  let fillPercent = 0;
  if (isValidated) {
    fillPercent = 100;
  } else if (subtasks.length > 0) {
    fillPercent = Math.round((doneCount / subtasks.length) * 100);
  }

  let html = getLiquidFillHTML(fillPercent);

  let emailLinkCal = '';
  const emailUrl = safeEmailUrl(task.emailUrl);
  if (emailUrl) {
    emailLinkCal = `
      <a href="${escapeHtml(emailUrl)}" target="_blank" rel="noopener noreferrer" class="cal-btn-mail-minimal" title="Ouvrir le mail UTC (${escapeHtml(task.emailSubject || ('UID ' + task.emailUid))})">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
          <polyline points="22,6 12,13 2,6"></polyline>
        </svg>
        <span>Mail</span>
      </a>
    `;
  }

  const genre = libelleGenre(task);
  html += `
    <div class="cal-task-header">
      <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
        <span class="course-badge ${classeMatiere(task.course)}">${escapeHtml(task.course)}</span>
        ${isValidated ? `<span class="validated-flag-pill">✓ VALIDÉ</span>` : (isEval ? `<span class="eval-flag-pill">ÉVAL</span>` : (genre ? `<span class="kind-flag-pill">${genre}</span>` : ''))}
      </div>
      <span class="cal-task-due">${escapeHtml(horaire(task) || task.dueDisplay || '')}</span>
    </div>
    <div class="cal-task-title">${escapeHtml(task.title)}</div>
    ${task.location ? `<div class="cal-task-where">${ICONE_LIEU}<span>${escapeHtml(task.location)}</span></div>` : ''}
  `;

  // Bullet points des exercices dans la carte calendrier
  if (subtasks.length > 0) {
    html += `<div class="cal-subtasks-list">`;
    subtasks.forEach(st => {
      html += `
        <div class="cal-subtask-item ${st.completed ? 'is-completed' : ''}" data-task-id="${escapeHtml(task.id)}" data-subtask-id="${escapeHtml(st.id)}">
          <div class="cal-bullet">
            <span class="cal-bullet-dot"></span>
          </div>
          <span>${escapeHtml(st.title)}</span>
        </div>
      `;
    });
    html += `</div>`;
  }

  // Footer : Label progression + Bouton mail minimal + Bouton "Valider"
  let btnClass = 'btn-cal-validate';
  let btnText = 'Valider';
  if (isValidated) {
    btnClass += ' is-validated';
    btnText = '✓ Validé';
  } else if (isFullyDone) {
    btnClass += ' is-ready';
    btnText = '✓ Valider';
  }

  html += `
    <div class="cal-task-footer">
      <div class="cal-footer-meta-col">
        <span class="cal-progress-label">${libelleProgression(task, doneCount, subtasks.length)}</span>
        ${emailLinkCal}
      </div>
      <button class="${btnClass}" data-task-id="${escapeHtml(task.id)}" title="${isValidated ? 'Cliquer pour réouvrir le devoir si besoin' : 'Valider le devoir'}">
        ${btnText}
      </button>
    </div>
  `;

  card.innerHTML = html;

  // Interaction bullet points
  card.querySelectorAll('.cal-subtask-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = item.getAttribute('data-task-id');
      const subtaskId = item.getAttribute('data-subtask-id');
      toggleSubtask(taskId, subtaskId);
    });
  });

  // Action Valider / Réouvrir depuis le calendrier
  const btnValidate = card.querySelector('.btn-cal-validate');
  if (btnValidate) {
    btnValidate.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btnValidate.getAttribute('data-task-id');
      toggleValidateTask(taskId);
    });
  }

  return card;
}

/**
 * Construit l'élément DOM d'une carte de devoir avec motion design (Vue Liste)
 */
function createTaskCardElement(task) {
  const card = document.createElement('article');
  const isValidated = task.status === 'archived';
  const isEval = estEvaluation(task);
  const isPast = Boolean(task.dueDate && task.dueDate < aujourdhuiIso());

  card.className = `homework-card ${isValidated ? 'is-validated' : ''} ${isEval && !isValidated ? 'is-evaluation' : ''} ${isPast ? 'is-past-due' : ''} ${estCreneau(task) ? 'is-creneau' : ''}`;
  card.id = `card-${task.id}`;

  const subtasks = task.subtasks || [];
  const totalSub = subtasks.length;
  const doneSub = subtasks.filter(st => st.completed).length;
  const isFullyDone = totalSub > 0 && doneSub === totalSub;

  let fillPercent = 0;
  if (isValidated) {
    fillPercent = 100;
  } else if (totalSub > 0) {
    fillPercent = Math.round((doneSub / totalSub) * 100);
  }

  const liquidHTML = getLiquidFillHTML(fillPercent);

  // Header de la carte
  const isUrgent = task.priority === 'urgent' || isEval;
  const genre = libelleGenre(task);
  const quand = [task.dueDisplay || task.dueDate || 'Échéance', horaire(task)].filter(Boolean).join(' · ');

  let emailLinkList = '';
  const emailUrl = safeEmailUrl(task.emailUrl);
  if (emailUrl) {
    emailLinkList = `
      <a href="${escapeHtml(emailUrl)}" target="_blank" rel="noopener noreferrer" class="card-btn-mail-minimal" title="${escapeHtml(task.emailSubject || 'Ouvrir le mail d\'origine dans le Webmail UTC')}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
          <polyline points="22,6 12,13 2,6"></polyline>
        </svg>
        <span>Mail d'origine</span>
      </a>
    `;
  }

  let headerHTML = `
    <div class="card-header">
      <div class="course-tag-wrap">
        <span class="course-badge ${classeMatiere(task.course)}">${escapeHtml(task.course)}</span>
        ${isValidated ? `<span class="validated-flag-pill">✓ VALIDÉ</span>` : (isEval ? `<span class="eval-flag-pill">ÉVALUATION</span>` : (genre ? `<span class="kind-flag-pill">${genre}</span>` : ''))}
        ${task.professor ? `<span style="font-size:0.75rem; color:${isEval && !isValidated ? '#fee2e2' : 'var(--muted-dim)'};">${escapeHtml(task.professor)}</span>` : ''}
      </div>
      <span class="due-badge ${isUrgent ? 'is-urgent' : ''} ${isPast && !isValidated ? 'is-past-due' : ''}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
        ${escapeHtml(quand)}
        ${isPast && !isValidated ? '<span class="due-past-tag">Passé</span>' : ''}
      </span>
    </div>
    <h3 class="card-title">${escapeHtml(task.title)}</h3>
    ${task.location ? `<p class="card-where">${ICONE_LIEU}<span>${escapeHtml(task.location)}</span></p>` : ''}
    ${task.notes ? `<p class="card-notes">${escapeHtml(task.notes)}</p>` : ''}
  `;

  // Liste des sous-exercices avec bullet points interactifs
  let subtasksHTML = `<div class="subtasks-list">`;
  subtasks.forEach(st => {
    subtasksHTML += `
      <div class="subtask-item ${st.completed ? 'is-completed' : ''}" data-task-id="${escapeHtml(task.id)}" data-subtask-id="${escapeHtml(st.id)}">
        <div class="bullet-point ${st.completed ? 'is-checked' : ''}" role="checkbox" aria-checked="${st.completed}">
          <div class="bullet-inner-dot"></div>
          <svg class="bullet-check-icon" viewBox="0 0 16 16">
            <polyline points="3 8 7 12 13 4"></polyline>
          </svg>
        </div>
        <span class="subtask-label">${escapeHtml(st.title)}</span>
      </div>
    `;
  });
  subtasksHTML += `</div>`;

  const statHTML = totalSub === 0 && estCreneau(task)
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="10" x2="21" y2="10"></line></svg>
       <span>Créneau</span>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
       <span><strong>${doneSub}</strong> / ${totalSub} fait(s)</span>`;

  // Footer de la carte : Mail d'origine placé vers le bas à côté du bouton Valider
  let footerHTML = '';
  if (AppState.currentView === 'active') {
    footerHTML = `
      <div class="card-footer">
        <div class="card-progress-stat">
          ${statHTML}
        </div>
        <div class="card-footer-actions">
          ${emailLinkList}
          <button class="btn btn-outline btn-validate-task ${isFullyDone ? 'is-ready' : ''}" data-task-id="${escapeHtml(task.id)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span>${isFullyDone ? 'Valider le devoir' : 'Valider'}</span>
          </button>
        </div>
      </div>
    `;
  } else {
    footerHTML = `
      <div class="card-footer">
        <span class="archive-timestamp">Validé le : ${escapeHtml(formatHorodatage(task.archivedAt))}</span>
        <div class="card-footer-actions">
          ${emailLinkList}
          <button class="btn btn-restore-task" data-task-id="${escapeHtml(task.id)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            <span>Restaurer</span>
          </button>
        </div>
      </div>
    `;
  }

  card.innerHTML = liquidHTML + headerHTML + subtasksHTML + footerHTML;

  // Interaction bullet points (clic sur un exercice)
  card.querySelectorAll('.subtask-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const taskId = item.getAttribute('data-task-id');
      const subtaskId = item.getAttribute('data-subtask-id');
      const bullet = item.querySelector('.bullet-point');

      bullet.classList.add('bullet-clicked');
      setTimeout(() => bullet.classList.remove('bullet-clicked'), 350);

      toggleSubtask(taskId, subtaskId);
    });
  });

  // Action Valider le devoir
  const btnValidate = card.querySelector('.btn-validate-task');
  if (btnValidate) {
    btnValidate.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btnValidate.getAttribute('data-task-id');
      toggleValidateTask(taskId);
    });
  }

  // Action Restaurer
  const btnRestore = card.querySelector('.btn-restore-task');
  if (btnRestore) {
    btnRestore.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btnRestore.getAttribute('data-task-id');
      toggleValidateTask(taskId);
    });
  }

  return card;
}

/**
 * Met à jour dynamiquement et en direct les éléments d'une tâche dans le DOM
 * Anime le remplissage liquide (ex: 25% -> 50% -> 75% -> 100%) sans recharger le DOM
 */
function updateTaskElementsInDOM(task) {
  const subtasks = task.subtasks || [];
  const total = subtasks.length;
  const doneCount = subtasks.filter(st => st.completed).length;
  const isFullyDone = total > 0 && doneCount === total;
  const isValidated = task.status === 'archived';
  const isEval = estEvaluation(task);
  const isPast = Boolean(task.dueDate && task.dueDate < aujourdhuiIso());

  let fillPercent = 0;
  if (isValidated) {
    fillPercent = 100;
  } else if (total > 0) {
    fillPercent = Math.round((doneCount / total) * 100);
  }

  // 1. Mise à jour de la carte Calendrier
  const calCard = document.getElementById(`cal-card-${task.id}`);
  if (calCard) {
    // Hauteur liquide fluide
    const calFill = calCard.querySelector('.card-liquid-fill');
    if (calFill) {
      calFill.style.height = `${fillPercent}%`;
      if (fillPercent > 0) calFill.classList.add('is-visible');
      else calFill.classList.remove('is-visible');
    }

    // Classes de la carte
    calCard.className = `cal-task-card ${isValidated ? 'is-validated' : ''} ${isEval && !isValidated ? 'is-evaluation' : ''} ${isPast ? 'is-past-due' : ''} ${estCreneau(task) ? 'is-creneau' : ''}`;

    // Bullet points calendrier
    calCard.querySelectorAll('.cal-subtask-item').forEach(item => {
      const stId = item.getAttribute('data-subtask-id');
      const st = subtasks.find(s => s.id === stId);
      if (st) {
        if (st.completed) item.classList.add('is-completed');
        else item.classList.remove('is-completed');
      }
    });

    // Label de progression
    const progressLbl = calCard.querySelector('.cal-progress-label');
    if (progressLbl) {
      progressLbl.textContent = libelleProgression(task, doneCount, total);
    }

    // Bouton de validation calendrier (Stricte consigne : PAS de bouton archiver)
    const btnCal = calCard.querySelector('.btn-cal-validate');
    if (btnCal) {
      if (isValidated) {
        btnCal.className = 'btn-cal-validate is-validated';
        btnCal.textContent = '✓ Validé';
        btnCal.title = 'Cliquer pour réouvrir le devoir si besoin';
      } else if (isFullyDone) {
        btnCal.className = 'btn-cal-validate is-ready';
        btnCal.textContent = '✓ Valider';
        btnCal.title = 'Valider le devoir';
      } else {
        btnCal.className = 'btn-cal-validate';
        btnCal.textContent = 'Valider';
        btnCal.title = 'Valider le devoir';
      }
    }

    // Badge en haut à gauche
    const headerTags = calCard.querySelector('.cal-task-header > div');
    if (headerTags) {
      const oldFlag = headerTags.querySelector('.validated-flag-pill, .eval-flag-pill, .kind-flag-pill');
      if (oldFlag) oldFlag.remove();
      const genre = libelleGenre(task);
      if (isValidated || isEval || genre) {
        const flag = document.createElement('span');
        flag.className = isValidated ? 'validated-flag-pill' : (isEval ? 'eval-flag-pill' : 'kind-flag-pill');
        flag.textContent = isValidated ? '✓ VALIDÉ' : (isEval ? 'ÉVAL' : genre);
        headerTags.appendChild(flag);
      }
    }
  }

  // 2. Mise à jour de la carte Liste
  const listCard = document.getElementById(`card-${task.id}`);
  if (listCard) {
    const listFill = listCard.querySelector('.card-liquid-fill');
    if (listFill) {
      listFill.style.height = `${fillPercent}%`;
      if (fillPercent > 0) listFill.classList.add('is-visible');
      else listFill.classList.remove('is-visible');
    }

    if (isFullyDone) {
      listCard.classList.add('is-fully-completed');
    } else {
      listCard.classList.remove('is-fully-completed');
    }

    listCard.querySelectorAll('.subtask-item').forEach(item => {
      const stId = item.getAttribute('data-subtask-id');
      const st = subtasks.find(s => s.id === stId);
      if (st) {
        const bullet = item.querySelector('.bullet-point');
        if (st.completed) {
          item.classList.add('is-completed');
          if (bullet) bullet.classList.add('is-checked');
        } else {
          item.classList.remove('is-completed');
          if (bullet) bullet.classList.remove('is-checked');
        }
        if (bullet) bullet.setAttribute('aria-checked', String(Boolean(st.completed)));
      }
    });

    const statCount = listCard.querySelector('.card-progress-stat strong');
    if (statCount) statCount.textContent = doneCount;

    const btnVal = listCard.querySelector('.btn-validate-task');
    if (btnVal) {
      if (isFullyDone) {
        btnVal.classList.add('is-ready');
        btnVal.querySelector('span').textContent = 'Valider le devoir';
      } else {
        btnVal.classList.remove('is-ready');
        btnVal.querySelector('span').textContent = 'Valider';
      }
    }
  }
}

/**
 * Coche ou décoche un exercice. On envoie la valeur voulue (jamais une bascule), une demande à la fois par
 * exercice : des clics rapides finissent toujours sur le dernier état choisi.
 */
function toggleSubtask(taskId, subtaskId) {
  if (!peutModifier()) return;
  const task = AppState.tasks.find(t => t.id === taskId);
  if (!task) return;
  const sub = (task.subtasks || []).find(st => st.id === subtaskId);
  if (!sub) return;

  const statutAvant = task.status;
  const voulu = !sub.completed;
  const cle = `${taskId}\u0000${subtaskId}`;
  const envoi = COCHES_EN_COURS.get(cle) || { tacheId: taskId, sousTacheId: subtaskId, voulu, enVol: false };
  envoi.voulu = voulu;
  COCHES_EN_COURS.set(cle, envoi);

  // Affichage immédiat
  sub.completed = voulu;
  if (!voulu && task.status === 'archived') {
    task.status = 'active';
    task.archivedAt = null;
  }
  updateTaskElementsInDOM(task);
  updateMetrics();
  if (task.status !== statutAvant && AppState.currentView !== 'calendar') renderTaskList();

  pousserCoche(cle);
}

async function pousserCoche(cle) {
  const envoi = COCHES_EN_COURS.get(cle);
  if (!envoi || envoi.enVol) return;   // l'envoi en vol reprendra la dernière valeur voulue
  envoi.enVol = true;
  let tacheServeur = null;
  let valeurEnvoyee = envoi.voulu;
  try {
    for (;;) {
      valeurEnvoyee = envoi.voulu;
      const data = await D.cocher(envoi.tacheId, envoi.sousTacheId, valeurEnvoyee);
      tacheServeur = data && data.task;
      if (envoi.voulu === valeurEnvoyee) break;
    }
  } catch (err) {
    COCHES_EN_COURS.delete(cle);
    revenirAuServeur(envoi.tacheId);
    signalerEchec(err, 'Exercice non enregistré.');
    return;
  }
  COCHES_EN_COURS.delete(cle);
  const affichee = AppState.tasks.find(t => t.id === envoi.tacheId);
  const statutAvant = affichee ? affichee.status : null;
  const task = remplacerTache(tacheServeur);
  if (!task) return;
  updateTaskElementsInDOM(task);
  updateMetrics();
  if (task.status !== statutAvant && AppState.currentView !== 'calendar') renderTaskList();
  else renderTodayStrip();
  const sub = (task.subtasks || []).find(st => st.id === envoi.sousTacheId);
  showToast(valeurEnvoyee ? `✓ ${sub ? sub.title : 'Exercice'} terminé` : 'Exercice remis à faire');
}

/**
 * Valide ou réouvre un devoir avec animation de chargement liquide
 * Une fois validé :
 * - Devient entièrement vert (toute verte)
 * - Reste visible en vert dans le calendrier
 * - Disparaît de la page "Tous les devoirs"
 */
async function toggleValidateTask(taskId) {
  const task = AppState.tasks.find(t => t.id === taskId);
  if (!task || VALIDATIONS_EN_COURS.has(taskId)) return;
  if (!peutModifier()) return;

  const calCard = document.getElementById(`cal-card-${task.id}`);
  const listCard = document.getElementById(`card-${task.id}`);

  if (task.status === 'archived') {
    VALIDATIONS_EN_COURS.set(taskId, false);
    try {
      const data = await D.archiver(taskId, false);
      VALIDATIONS_EN_COURS.delete(taskId);
      const maj = remplacerTache(data && data.task) || task;
      updateTaskElementsInDOM(maj);
      updateMetrics();
      if (AppState.currentView === 'active' || AppState.currentView === 'archived') renderTaskList();
      showToast(`Devoir "${maj.title}" réouvert dans les devoirs à faire`);
    } catch (err) {
      VALIDATIONS_EN_COURS.delete(taskId);
      revenirAuServeur(taskId);
      signalerEchec(err, 'Le devoir n’a pas pu être rouvert.');
    }
    return;
  }

  const subtasks = task.subtasks || [];
  VALIDATIONS_EN_COURS.set(taskId, true);

  if (calCard) {
    const fill = calCard.querySelector('.card-liquid-fill');
    if (fill) {
      fill.classList.add('is-visible');
      fill.style.height = '100%';
    }
    calCard.classList.add('is-validating-surge');
    calCard.querySelectorAll('.cal-subtask-item').forEach(item => item.classList.add('is-completed'));
    const pLbl = calCard.querySelector('.cal-progress-label');
    if (pLbl) pLbl.textContent = libelleProgression(task, subtasks.length, subtasks.length);
    const btn = calCard.querySelector('.btn-cal-validate');
    if (btn) {
      btn.textContent = 'Validation...';
      btn.className = 'btn-cal-validate is-ready';
    }
  }

  if (listCard) {
    const fill = listCard.querySelector('.card-liquid-fill');
    if (fill) {
      fill.classList.add('is-visible');
      fill.style.height = '100%';
    }
    listCard.classList.add('is-validating-surge');
    listCard.querySelectorAll('.subtask-item').forEach(item => {
      item.classList.add('is-completed');
      const b = item.querySelector('.bullet-point');
      if (b) b.classList.add('is-checked');
    });
  }

  window.setTimeout(async () => {
    let maj;
    try {
      const data = await D.archiver(taskId, true);
      VALIDATIONS_EN_COURS.delete(taskId);
      maj = remplacerTache(data && data.task) || task;
    } catch (err) {
      VALIDATIONS_EN_COURS.delete(taskId);
      revenirAuServeur(taskId);
      signalerEchec(err, 'Le devoir n’a pas pu être validé.');
      return;
    }
    updateMetrics();
    const calCardNow = document.getElementById(`cal-card-${taskId}`);
    const listCardNow = document.getElementById(`card-${taskId}`);
    if (calCardNow) {
      calCardNow.classList.remove('is-validating-surge');
      updateTaskElementsInDOM(maj);
    }

    // Dans la page "Tous les devoirs" : elle n'est plus visible, donc animation de sortie
    if (listCardNow && AppState.currentView === 'active') {
      listCardNow.classList.add('is-archiving');
      setTimeout(() => {
        renderTaskList();
      }, 350);
    } else if (listCardNow) {
      updateTaskElementsInDOM(maj);
    }

    showToast(`✓ "${maj.title}" validé ! Devenu tout vert dans le calendrier.`);
  }, 420);
}

/**
 * Affiche une notification discrète style toast
 */
let toastTimeout = null;
function showToast(text, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.style.borderColor = isError ? '#ef4444' : 'var(--line-strong)';
  toast.classList.add('is-active');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove('is-active');
  }, isError ? 4200 : 2400);
}

function formatDateDisplay(isoDate) {
  if (!isoDate) return "";
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const days = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const months = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

function getCourseName(tag) {
  const map = {
    'MT02': 'Maths 2 (Algèbre linéaire)',
    'MT03': 'Maths 3 (Analyse)',
    'PS21': 'Mécanique du point',
    'NP90': 'Nano-projet & Mesures (NP90)',
    'PS90': 'Mesures & Projet (PS90)',
    'LA21': 'Espagnol',
    'IS00': 'ISO (Environnement)',
    'GE28': 'Droit & Gestion',
    'CAMPUS': 'Vie étudiante & Campus'
  };
  return map[String(tag || '').toUpperCase()] || tag;
}

/**
 * SUPERVISION HUMAINE (HITL)
 * Affiche et arbitre les courriels importants mais ambigus
 */
function updateSupervisionBadge() {
  const badge = document.getElementById('countSupervision');
  if (badge) {
    const pendingCount = (AppState.supervisionItems || []).filter(it => it.status === 'pending').length;
    badge.textContent = pendingCount;
    badge.style.display = pendingCount > 0 ? 'inline-flex' : 'none';
  }
}

function renderSupervisionView() {
  const grid = document.getElementById('supervisionGrid');
  const empty = document.getElementById('supervisionEmpty');
  if (!grid || !empty) return;

  const pending = (AppState.supervisionItems || []).filter(it => it.status === 'pending');
  updateSupervisionBadge();

  if (pending.length === 0) {
    grid.style.display = 'none';
    empty.style.display = AppState.etatRecu ? 'block' : 'none';
    return;
  }

  grid.style.display = 'grid';
  empty.style.display = 'none';
  grid.innerHTML = '';

  pending.forEach(item => {
    const card = document.createElement('article');
    card.className = 'supervision-card';
    card.setAttribute('data-id', item.id);

    const emailUrl = safeEmailUrl(item.emailUrl);
    const emailLinkHtml = emailUrl
      ? `<a href="${escapeHtml(emailUrl)}" target="_blank" rel="noopener noreferrer" class="supervision-mail-link" title="Ouvrir directement ce courriel dans Webmail UTC">
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
           <span>UID ${escapeHtml(item.emailUid || '?')} • Webmail UTC ↗</span>
         </a>`
      : '';

    card.innerHTML = `
      <div class="supervision-card-header">
        <div class="supervision-badges">
          <span class="badge-pill course-${escapeHtml(String(item.course || 'autre').toLowerCase().replace(/[^a-z0-9]/g, ''))}">${escapeHtml(item.course || 'CAMPUS')}</span>
          <span class="supervision-pill-hitl">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
            À arbitrer
          </span>
        </div>
        ${emailLinkHtml}
      </div>

      <h3 class="supervision-card-title">${escapeHtml(item.emailSubject || item.suggestedTitle)}</h3>

      <div class="supervision-meta-row">
        <span class="supervision-meta-item">
          <strong>Expéditeur :</strong> ${escapeHtml(item.emailSender || 'Inconnu')}
        </span>
        <span class="supervision-meta-item">
          <strong>Date :</strong> ${escapeHtml(item.emailDate || 'Non spécifiée')}
        </span>
      </div>

      <div class="supervision-reason-box">
        <div class="supervision-reason-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          Pourquoi l'agent hésite :
        </div>
        <p class="supervision-reason-text">${escapeHtml(item.reason)}</p>
      </div>

      ${item.snippet ? `
        <div class="supervision-snippet-box">
          <div class="supervision-snippet-label">Extrait du courriel :</div>
          <p class="supervision-snippet-text">« ${escapeHtml(item.snippet)} »</p>
        </div>
      ` : ''}

      <div class="supervision-actions">
        <button class="btn btn-sm btn-accent btn-sup-create" data-id="${escapeHtml(item.id)}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          Créer devoir en 1 clic
        </button>
        <button class="btn btn-sm btn-outline btn-sup-ack" data-id="${escapeHtml(item.id)}" title="Marquer comme lu et pris en compte sans créer de devoir">
          ✓ Info notée
        </button>
        <button class="btn btn-sm btn-ghost btn-sup-dismiss" data-id="${escapeHtml(item.id)}" title="Ignorer ce message">
          Ignorer
        </button>
      </div>
    `;

    card.querySelector('.btn-sup-create').addEventListener('click', () => {
      if (!peutModifier()) return;
      prefillAddModalFromSupervision(item);
    });

    card.querySelector('.btn-sup-ack').addEventListener('click', () => {
      resolveSupervisionItem(item.id, 'resolved', '✓ Courriel marqué comme noté.');
    });

    card.querySelector('.btn-sup-dismiss').addEventListener('click', () => {
      resolveSupervisionItem(item.id, 'dismissed', 'Courriel ignoré.');
    });

    grid.appendChild(card);
  });
}

async function resolveSupervisionItem(itemId, statut = 'resolved', toastMsg = 'Arbitré avec succès.') {
  if (ARBITRAGES_EN_COURS.has(itemId)) return false;
  if (!peutModifier()) return false;
  ARBITRAGES_EN_COURS.add(itemId);
  try {
    await D.arbitrer(itemId, statut);
  } catch (err) {
    ARBITRAGES_EN_COURS.delete(itemId);
    signalerEchec(err, 'La décision n’a pas été enregistrée.');
    return false;
  }
  ARBITRAGES_EN_COURS.delete(itemId);
  versionLocale += 1;
  AppState.supervisionItems = AppState.supervisionItems.filter(it => it.id !== itemId);
  renderSupervisionView();
  showToast(toastMsg);
  return true;
}

function prefillAddModalFromSupervision(item) {
  ouvrirModale();
  activeSupervisionContext = item;

  const taskTitle = document.getElementById('taskTitle');
  const taskCourse = document.getElementById('taskCourse');
  const taskDueDate = document.getElementById('taskDueDate');
  const taskDue = document.getElementById('taskDue');
  const taskNotes = document.getElementById('taskNotes');

  taskTitle.value = item.suggestedTitle || item.emailSubject || '';

  if (item.course) {
    const courseVal = String(item.course).toUpperCase();
    const options = Array.from(taskCourse.options).map(o => o.value);
    if (options.includes(courseVal)) {
      taskCourse.value = courseVal;
    } else if (courseVal.includes('NP90') || courseVal.includes('PS90')) {
      taskCourse.value = 'NP90';
    } else {
      taskCourse.value = 'CAMPUS';
    }
  }

  taskDueDate.value = item.suggestedDueDate || aujourdhuiIso();
  if (item.suggestedDueDate) taskDue.value = formatDateDisplay(item.suggestedDueDate);

  let notesText = '';
  if (item.snippet) notesText += `Extrait : ${item.snippet}`;
  taskNotes.value = notesText;

  reinitialiserExercices('Ex: Action à mener');
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeEmailUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'webmail.utc.fr' ? url.toString() : null;
  } catch {
    return null;
  }
}

// Les scripts sont en fin de page : le DOM est prêt. Appelé en dernier (constantes ci-dessus initialisées).
initApp();
