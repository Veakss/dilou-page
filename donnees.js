/**
 * Couche de données de Dilou : appels aux fonctions public.dilou_* de Supabase, clé d'accès de l'appareil,
 * copie locale pour la lecture hors connexion, temps réel. app.js ne parle au serveur que par ici.
 *
 * Sécurité : l'adresse du serveur vient UNIQUEMENT de config.js (window.DILOU_CONFIG). Aucun paramètre d'adresse
 * ne peut la changer : un lien piégé ne peut pas envoyer la clé ailleurs.
 */
(function () {
  'use strict';

  const CONFIG = Object.freeze({
    url: String((window.DILOU_CONFIG && window.DILOU_CONFIG.supabaseUrl) || '').replace(/\/+$/, ''),
    clePublique: String((window.DILOU_CONFIG && window.DILOU_CONFIG.supabaseClePublique) || ''),
  });

  const CLE_STOCKAGE = 'dilou_cle';
  const CACHE_STOCKAGE = 'dilou_etat_cache';
  const DELAI_APPEL_MS = 15000;
  // Clé créée par dilou.creer_cle : base64 « url » de 32 octets (≈ 44 caractères). Bornes larges, alphabet strict.
  const FORME_CLE = /^[A-Za-z0-9_-]{20,200}$/;

  // Messages lisibles pour les erreurs levées par schema.sql.
  const MESSAGES = {
    cle_invalide: 'Ce Mac n’est plus reconnu par le calendrier.',
    sous_tache_introuvable: 'Cet exercice n’existe plus (supprimé depuis un autre ordinateur).',
    tache_introuvable: 'Ce devoir n’existe plus (supprimé depuis un autre ordinateur).',
    element_introuvable: 'Ce courriel a déjà été arbitré ailleurs.',
    titre_requis: 'Le devoir doit avoir un intitulé.',
    identifiant_invalide: 'Identifiant de devoir invalide.',
    statut_invalide: 'Décision inconnue.',
  };

  class ErreurDilou extends Error {
    /** genre : 'cle' (clé absente ou refusée), 'reseau' (serveur injoignable), 'serveur' (refus métier ou panne) */
    constructor(genre, message, code) {
      super(message);
      this.name = 'ErreurDilou';
      this.genre = genre;
      this.code = code || null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Stockage local : jamais bloquant (navigation privée, données bloquées…)
  // ---------------------------------------------------------------------------------------------------------------
  function lireStockage(nom) {
    try { return window.localStorage.getItem(nom); } catch { return null; }
  }
  function ecrireStockage(nom, valeur) {
    try { window.localStorage.setItem(nom, valeur); return true; } catch { return false; }
  }
  function effacerStockage(nom) {
    try { window.localStorage.removeItem(nom); } catch { /* rien à faire */ }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Clé d'accès de l'appareil
  // ---------------------------------------------------------------------------------------------------------------
  let cleMemoire = null;  // secours si localStorage est indisponible : la clé vaut pour la session de l'onglet
  let clePrecedente = null;  // clé qui marchait avant un nouveau lien : reprise si le lien est refusé

  /** Extrait la clé d'un lien collé (« …#cle=XXX ») ou d'une clé seule. Seule la clé est retenue, jamais l'adresse. */
  function extraireCle(texte) {
    const brut = String(texte || '').trim();
    if (!brut) return null;
    const trouve = brut.match(/[#&?]cle=([^&#\s]+)/);
    let cle = trouve ? trouve[1] : brut;
    try { cle = decodeURIComponent(cle); } catch { /* garder tel quel */ }
    return FORME_CLE.test(cle) ? cle : null;
  }

  /** Au premier passage : prend « #cle=… » dans l'adresse, la range, puis la retire de l'adresse. */
  function prendreCleDansAdresse() {
    const hash = window.location.hash || '';
    if (!/(^#|&)cle=/.test(hash)) return;
    const cle = extraireCle(hash);
    // Retirer le fragment dans tous les cas (même une clé mal formée ne doit pas rester visible ni dans l'historique).
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch { /* adresse inchangée : sans gravité */ }
    if (!cle) return;
    const actuelle = lireCleRangee();
    if (actuelle && actuelle !== cle) clePrecedente = actuelle;
    enregistrerCle(cle);
  }

  function enregistrerCle(cle) {
    cleMemoire = cle;
    ecrireStockage(CLE_STOCKAGE, cle);
  }

  function lireCleRangee() {
    const stockee = lireStockage(CLE_STOCKAGE);
    if (stockee && FORME_CLE.test(stockee)) return stockee;
    return cleMemoire;
  }

  function cle() {
    return lireCleRangee();
  }

  /**
   * Clé refusée. Si elle venait d'un nouveau lien et qu'une clé valable la précédait, on reprend celle-ci (un lien
   * piégé ne peut pas délier le Mac) et on renvoie true. Sinon on oublie la clé et la copie locale (un Mac délié
   * ne garde pas les devoirs affichés) et on renvoie false.
   */
  function oublierCle() {
    if (clePrecedente && clePrecedente !== lireCleRangee()) {
      enregistrerCle(clePrecedente);
      clePrecedente = null;
      return true;
    }
    clePrecedente = null;
    cleMemoire = null;
    effacerStockage(CLE_STOCKAGE);
    effacerStockage(CACHE_STOCKAGE);
    return false;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Appels RPC : POST {url}/rest/v1/rpc/<nom>, en-tête apikey seul (clé « sb_publishable_ », pas un JWT)
  // ---------------------------------------------------------------------------------------------------------------
  async function appeler(nom, params = {}, cleForcee = null) {
    const cleAppareil = cleForcee || cle();
    if (!cleAppareil) throw new ErreurDilou('cle', MESSAGES.cle_invalide, 'cle_absente');
    if (!CONFIG.url || !CONFIG.clePublique) throw new ErreurDilou('serveur', 'config.js incomplet.', 'config');

    const controle = new AbortController();
    const minuterie = setTimeout(() => controle.abort(), DELAI_APPEL_MS);
    let reponse;
    try {
      reponse = await fetch(`${CONFIG.url}/rest/v1/rpc/${encodeURIComponent(nom)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: CONFIG.clePublique },
        body: JSON.stringify({ p_cle: cleAppareil, ...params }),
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controle.signal,
      });
    } catch {
      throw new ErreurDilou('reseau', 'Calendrier injoignable (connexion ?).', 'reseau');
    } finally {
      clearTimeout(minuterie);
    }

    const texte = await reponse.text().catch(() => '');
    let corps = null;
    try { corps = texte ? JSON.parse(texte) : null; } catch { corps = null; }

    if (!reponse.ok) {
      const message = String((corps && corps.message) || '');
      if (reponse.status === 403 || /cle_invalide/.test(message)) {
        throw new ErreurDilou('cle', MESSAGES.cle_invalide, 'cle_invalide');
      }
      // 5xx, 429, passerelle : on traite comme une panne passagère (lecture seule, nouvel essai plus tard).
      if (reponse.status >= 500 || reponse.status === 429 || reponse.status === 0) {
        throw new ErreurDilou('reseau', 'Calendrier momentanément indisponible.', `http_${reponse.status}`);
      }
      const code = Object.keys(MESSAGES).find(c => message.includes(c));
      throw new ErreurDilou('serveur', code ? MESSAGES[code] : 'La modification a été refusée par le calendrier.',
                            code || `http_${reponse.status}`);
    }
    return corps;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Copie locale du dernier état (lecture seule hors connexion)
  // ---------------------------------------------------------------------------------------------------------------
  function sauverCache(etat) {
    ecrireStockage(CACHE_STOCKAGE, JSON.stringify({ ...etat, enregistreLe: new Date().toISOString() }));
  }
  function lireCache() {
    const brut = lireStockage(CACHE_STOCKAGE);
    if (!brut) return null;
    try {
      const etat = JSON.parse(brut);
      return etat && Array.isArray(etat.tasks) ? etat : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Identifiant d'un devoir créé ici : fixé AVANT l'envoi, pour qu'une nouvelle tentative ne crée pas de doublon
  // ---------------------------------------------------------------------------------------------------------------
  function nouvelIdentifiant(prefixe = 'manuel') {
    let alea = '';
    try {
      alea = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    } catch {
      const octets = new Uint8Array(8);
      crypto.getRandomValues(octets);
      alea = Array.from(octets, o => o.toString(16).padStart(2, '0')).join('');
    }
    return `${prefixe}-${Date.now().toString(36)}-${alea}`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Temps réel : canal public « dilou », événement broadcast « maj ». Facultatif : sans lui, la vérification
  // périodique suffit.
  // ---------------------------------------------------------------------------------------------------------------
  let canal = null;
  function abonnerTempsReel(surMaj, surEtat) {
    if (canal) return true;
    const lib = window.supabase;
    if (!lib || typeof lib.createClient !== 'function' || !CONFIG.url || !CONFIG.clePublique) return false;
    try {
      const client = lib.createClient(CONFIG.url, CONFIG.clePublique, {
        // Pas de session ni de lecture de l'adresse : supabase-js ne sert ici qu'au canal broadcast.
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      canal = client.channel('dilou', { config: { broadcast: { self: false } } });
      canal.on('broadcast', { event: 'maj' }, message => surMaj((message && message.payload) || {}));
      canal.subscribe(statut => { if (surEtat) surEtat(statut); });
      return true;
    } catch {
      canal = null;
      return false;
    }
  }

  window.DilouDonnees = Object.freeze({
    ErreurDilou,
    prendreCleDansAdresse,
    extraireCle,
    enregistrerCle,
    cle,
    oublierCle,
    sauverCache,
    lireCache,
    nouvelIdentifiant,
    abonnerTempsReel,

    etat: () => appeler('dilou_etat'),
    revision: () => appeler('dilou_revision'),
    /** Essaie une clé avant de la ranger (écran de liaison). */
    essayerCle: c => appeler('dilou_etat', {}, c),
    cocher: (tacheId, sousTacheId, faite) =>
      appeler('dilou_cocher', { p_tache_id: tacheId, p_sous_tache_id: sousTacheId, p_faite: Boolean(faite) }),
    archiver: (tacheId, archiver) =>
      appeler('dilou_archiver', { p_tache_id: tacheId, p_archiver: Boolean(archiver) }),
    ajouterTache: (tache, supervisionId = null) =>
      appeler('dilou_ajouter_tache', { p_tache: tache, p_supervision_id: supervisionId }),
    supprimerTache: tacheId => appeler('dilou_supprimer_tache', { p_tache_id: tacheId }),
    arbitrer: (id, statut) => appeler('dilou_arbitrer', { p_id: id, p_statut: statut }),
  });
})();
