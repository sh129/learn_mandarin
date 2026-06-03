'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let allCards      = [];
let progress      = {};
let customCards   = [];
let queue         = [];
let queueIndex    = 0;
let sessionCorrect = 0;
let cardFlipped   = false;
let activeCategory  = 'all';
let activeDirection = 'en-zh';  // 'en-zh' | 'zh-en' | 'both'
let handsFreeActive = false;
let hfRecognition   = null;

// Progress key — EN→ZH reuses bare id (backward compat); ZH→EN gets '_zh' suffix
function pKey(item) {
  return item._direction === 'zh-en' ? item.id + '_zh' : item.id;
}

const CATEGORY_LABELS = {
  all:        'All',
  greetings:  'Greetings',
  people:     'People',
  actions:    'Actions',
  adjectives: 'Adjectives',
  numbers:    'Numbers',
  time:       'Time',
  food:       'Food & Drink',
  places:     'Places',
  objects:    'Objects',
  directions: 'Directions',
  questions:  'Questions',
  basics:     'Basics',
  phrases:    'Phrases',
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const screens = {
  loading: document.getElementById('screen-loading'),
  study:   document.getElementById('screen-study'),
  done:    document.getElementById('screen-done'),
  add:     document.getElementById('screen-add'),
};

const el = {
  progressBar:   document.getElementById('progress-bar'),
  progressText:  document.getElementById('progress-text'),
  card:          document.getElementById('card'),
  cardFront:     document.querySelector('.card-front'),
  cardBack:      document.querySelector('.card-back'),
  cardTypeBadge: document.getElementById('card-type-badge'),
  cardEnglish:   document.getElementById('card-english'),
  cardChars:     document.getElementById('card-characters'),
  cardPinyin:    document.getElementById('card-pinyin'),
  cardEnSmall:   document.getElementById('card-english-small'),
  btnTts:        document.getElementById('btn-tts'),
  speechStatus:  document.getElementById('speech-status'),
  speechResult:  document.getElementById('speech-result'),
  frontButtons:  document.getElementById('front-buttons'),
  backButtons:   document.getElementById('back-buttons'),
  doneStats:     document.getElementById('done-stats'),
  doneNext:      document.getElementById('done-next'),
  customCardList:document.getElementById('custom-card-list'),
  newEnglish:    document.getElementById('new-english'),
  newPinyin:     document.getElementById('new-pinyin'),
  newChars:      document.getElementById('new-characters'),
  newType:       document.getElementById('new-type'),
};

// ── SM-2 ─────────────────────────────────────────────────────────────────────
function sm2(prev, level) {
  // level: 0=again, 1=good, 2=easy
  let { interval = 0, easeFactor = 2.5, repetitions = 0 } = prev || {};
  const sm2Grade = [0, 4, 5][level];

  if (sm2Grade < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    if (repetitions === 0)      interval = 1;
    else if (repetitions === 1) interval = 6;
    else                        interval = Math.round(interval * easeFactor);
    repetitions++;
  }

  if (level === 2) interval = Math.round(interval * 1.3);

  easeFactor = Math.max(1.3,
    easeFactor + 0.1 - (5 - sm2Grade) * (0.08 + (5 - sm2Grade) * 0.02)
  );

  const due = new Date();
  due.setDate(due.getDate() + interval);

  return { interval, easeFactor, repetitions, due: dateStr(due) };
}

// ── Text-to-speech ────────────────────────────────────────────────────────────
function speak(text) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 0.8;
  el.btnTts.classList.add('speaking');
  utterance.onend = () => el.btnTts.classList.remove('speaking');
  utterance.onerror = () => el.btnTts.classList.remove('speaking');
  speechSynthesis.speak(utterance);
}

// ── Audio feedback ────────────────────────────────────────────────────────────
let _audioCtx = null;

// Create the context on the first user gesture so it starts in running state
document.addEventListener('pointerdown', function warmAudio() {
  if (_audioCtx) return;
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {}
}, { passive: true });

async function _playTones(tones) {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Wait for resume to fully complete before reading currentTime
    if (_audioCtx.state !== 'running') await _audioCtx.resume();
    const now = _audioCtx.currentTime;
    tones.forEach(([freq, offset, dur, gain, freqEnd]) => {
      const osc = _audioCtx.createOscillator();
      const vol = _audioCtx.createGain();
      osc.connect(vol);
      vol.connect(_audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + offset);
      if (freqEnd !== undefined) {
        osc.frequency.linearRampToValueAtTime(freqEnd, now + offset + dur);
      }
      vol.gain.setValueAtTime(gain, now + offset);
      vol.gain.exponentialRampToValueAtTime(0.001, now + offset + dur);
      osc.start(now + offset);
      osc.stop(now + offset + dur + 0.01);
    });
  } catch (e) {}
}

function playCorrectSound() {
  _playTones([
    [659, 0,    0.09, 0.22],        // E5
    [988, 0.07, 0.15, 0.22],        // B5
  ]);
}

function playIncorrectSound() {
  _playTones([
    [280, 0, 0.22, 0.15, 130],      // descending whomp
  ]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function dateStr(d) {
  return d.toISOString().split('T')[0];
}

function today() {
  return dateStr(new Date());
}

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

function saveProgress() {
  localStorage.setItem('mandarin_progress', JSON.stringify(progress));
}

function saveCustom() {
  localStorage.setItem('mandarin_custom', JSON.stringify(customCards));
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  progress    = JSON.parse(localStorage.getItem('mandarin_progress') || '{}');
  customCards = JSON.parse(localStorage.getItem('mandarin_custom')   || '[]');

  let hsk = [];
  try {
    const resp = await fetch('data/hsk.json');
    hsk = await resp.json();
  } catch (e) {
    console.error('Failed to load hsk.json', e);
  }

  allCards = [...hsk, ...customCards];
  buildFilterRow();
  buildSession();

  if (queue.length === 0) {
    showDone();
  } else {
    showScreen('study');
    renderCard();
  }
}

// ── Filter row ────────────────────────────────────────────────────────────────
function buildFilterRow() {
  const row = document.getElementById('filter-row');
  row.innerHTML = '';

  // Collect categories present in the deck, in the order defined by CATEGORY_LABELS
  const present = new Set(allCards.map(c => c.category).filter(Boolean));
  const order = Object.keys(CATEGORY_LABELS).filter(k => k === 'all' || present.has(k));

  order.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn' + (cat === activeCategory ? ' active' : '');
    btn.textContent = CATEGORY_LABELS[cat] || cat;
    btn.dataset.category = cat;
    row.appendChild(btn);
  });
}

// ── Session ───────────────────────────────────────────────────────────────────
function buildSession() {
  const t = today();
  const pool = activeCategory === 'all'
    ? allCards
    : allCards.filter(c => c.category === activeCategory);

  const dirs = activeDirection === 'both' ? ['en-zh', 'zh-en'] : [activeDirection];

  queue = pool.flatMap(card =>
    dirs.map(dir => ({ ...card, _direction: dir }))
  ).filter(item => {
    const p = progress[pKey(item)];
    return !p || p.due <= t;
  });

  // Fisher-Yates shuffle
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }

  queueIndex    = 0;
  sessionCorrect = 0;
}

// ── Render card ───────────────────────────────────────────────────────────────
function renderCard() {
  const card = queue[queueIndex];
  cardFlipped = false;

  // Snap instantly to English (front) side — no animation so the answer isn't visible during transition
  el.card.classList.add('no-transition');
  el.card.classList.remove('flipped');
  void el.card.offsetWidth; // force reflow before re-enabling transition
  el.card.classList.remove('no-transition');
  if (!handsFreeActive) {
    el.frontButtons.classList.remove('hidden');
    el.backButtons.classList.add('hidden');
    el.speechResult.className = 'hidden';
    el.speechStatus.textContent = '';
    if (window.speechSynthesis) speechSynthesis.cancel();
    el.btnTts.classList.remove('speaking');
  }

  // Clear grade highlights
  document.querySelectorAll('.grade-btn').forEach(b => b.classList.remove('highlighted'));

  const isZhEn = card._direction === 'zh-en';
  el.cardTypeBadge.textContent = card.type === 'phrase' ? 'phrase' : 'word';

  // ── Front face ──────────────────────────────────────────────────────
  const frontPinyin = document.getElementById('card-front-pinyin');
  const hintText    = document.getElementById('card-hint-text');
  if (isZhEn) {
    el.card.classList.add('zh-en-front');
    el.cardEnglish.textContent = card.characters;
    frontPinyin.textContent    = card.pinyin;
    frontPinyin.classList.remove('hidden');
    hintText.textContent = 'tap to reveal English';
  } else {
    el.card.classList.remove('zh-en-front');
    el.cardEnglish.textContent = card.english;
    frontPinyin.textContent    = '';
    frontPinyin.classList.add('hidden');
    hintText.textContent = 'tap card to reveal';
  }

  // ── Back face ───────────────────────────────────────────────────────
  const literalEl = document.getElementById('card-literal');
  if (isZhEn) {
    el.card.classList.add('zh-en-back');
    el.cardChars.textContent   = card.english;
    el.cardPinyin.textContent  = card.characters + '  ·  ' + card.pinyin;
    el.cardEnSmall.textContent = '';
    literalEl.classList.add('hidden');
  } else {
    el.card.classList.remove('zh-en-back');
    el.cardChars.textContent   = card.characters;
    el.cardPinyin.textContent  = card.pinyin;
    el.cardEnSmall.textContent = card.english;
    if (card.literal) {
      literalEl.textContent = card.literal;
      literalEl.classList.remove('hidden');
    } else {
      literalEl.classList.add('hidden');
    }
  }

  // Progress
  const done  = queueIndex;
  const total = queue.length;
  el.progressBar.style.width = `${(done / total) * 100}%`;
  el.progressText.textContent = `${done} / ${total}`;
}

function flipCard() {
  cardFlipped = !cardFlipped;
  el.card.classList.toggle('flipped', cardFlipped);
  el.frontButtons.classList.toggle('hidden', cardFlipped);
  el.backButtons.classList.toggle('hidden', !cardFlipped);

  if (!cardFlipped) {
    // Flipped back to English side — clear speech feedback
    el.speechResult.className = 'hidden';
    el.speechStatus.textContent = '';
    if (window.speechSynthesis) speechSynthesis.cancel();
    el.btnTts.classList.remove('speaking');
    document.querySelectorAll('.grade-btn').forEach(b => b.classList.remove('highlighted'));
  }
}

// ── Grading ───────────────────────────────────────────────────────────────────
function gradeCard(level) {
  if (level >= 1) playCorrectSound(); else playIncorrectSound();
  const card = queue[queueIndex];
  progress[pKey(card)] = sm2(progress[pKey(card)], level);
  saveProgress();

  if (level >= 1) sessionCorrect++;

  queueIndex++;
  if (queueIndex >= queue.length) {
    showDone();
  } else {
    renderCard();
  }
}

// ── Done screen ───────────────────────────────────────────────────────────────
function showDone() {
  const reviewed = queue.length;
  el.doneStats.textContent =
    reviewed === 0
      ? 'No cards due today.'
      : `${sessionCorrect} / ${reviewed} cards reviewed correctly.`;

  // Find next due card
  const upcoming = Object.values(progress)
    .map(p => p.due)
    .filter(d => d > today())
    .sort();

  el.doneNext.textContent = upcoming.length
    ? `Next cards due: ${upcoming[0]}`
    : '';

  showScreen('done');
}

// ── Speech recognition ────────────────────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

if (!SpeechRecognition) {
  document.body.classList.add('no-speech');
}

function startSpeech() {
  if (isListening || !SpeechRecognition) return;

  recognition = new SpeechRecognition();
  recognition.lang        = 'zh-CN';
  recognition.interimResults = false;
  recognition.maxAlternatives = 3;

  isListening = true;
  document.getElementById('btn-speak').classList.add('listening');
  el.speechStatus.textContent = 'Listening…';
  el.speechResult.classList.add('hidden');

  recognition.onresult = (event) => {
    const results = Array.from(event.results[0]).map(r => r.transcript.trim());
    const card = queue[queueIndex];
    const match = checkSpeechMatch(results, card.characters);
    showSpeechResult(match, results[0]);
  };

  recognition.onerror = (event) => {
    if (event.error === 'no-speech') {
      el.speechStatus.textContent = 'No speech detected. Try again.';
    } else if (event.error === 'not-allowed') {
      el.speechStatus.textContent = 'Microphone access denied.';
      document.body.classList.add('no-speech');
    } else {
      el.speechStatus.textContent = 'Could not recognize speech. Try again.';
    }
    stopListening();
  };

  recognition.onend = () => {
    stopListening();
  };

  recognition.start();
}

function stopListening() {
  isListening = false;
  document.getElementById('btn-speak').classList.remove('listening');
  if (el.speechStatus.textContent === 'Listening…') {
    el.speechStatus.textContent = '';
  }
}

function normalize(str) {
  return str.replace(/[^一-鿿㐀-䶿]/g, '');
}

function checkSpeechMatch(recognized, expected) {
  const expNorm = normalize(expected);
  for (const r of recognized) {
    const recNorm = normalize(r);
    if (!recNorm) continue;
    if (recNorm === expNorm) return true;
    if (recNorm.includes(expNorm) || expNorm.includes(recNorm)) return true;
  }
  return false;
}

function showSpeechResult(correct, recognized) {
  el.speechStatus.textContent = '';
  el.speechResult.classList.remove('hidden', 'correct', 'incorrect');

  if (correct) {
    el.speechResult.className = 'correct';
    el.speechResult.textContent = `✓ Correct! "${recognized}"`;
    document.querySelector('.grade-good').classList.add('highlighted');
  } else {
    el.speechResult.className = 'incorrect';
    const card = queue[queueIndex];
    el.speechResult.textContent = `✗ Heard: "${recognized || '—'}" (expected: ${card.characters})`;
    document.querySelector('.grade-again').classList.add('highlighted');
  }

  // Flip to show the answer
  flipCard();
}

// ── Add custom card ───────────────────────────────────────────────────────────
function renderCustomList() {
  el.customCardList.innerHTML = '';
  if (customCards.length === 0) return;

  const heading = document.createElement('h3');
  heading.textContent = 'Your cards';
  heading.style.cssText = 'padding:0 0 8px;font-size:15px;color:#666;';
  el.customCardList.appendChild(heading);

  customCards.forEach((card, i) => {
    const item = document.createElement('div');
    item.className = 'custom-card-item';
    item.innerHTML = `
      <div class="ccard-text">
        <div class="ccard-en">${card.english}</div>
        <div class="ccard-zh">${card.characters} · ${card.pinyin}</div>
      </div>
      <button class="btn-delete" data-index="${i}" title="Delete">✕</button>
    `;
    el.customCardList.appendChild(item);
  });
}

function addCustomCard(english, pinyin, characters, type, category) {
  const id = 'custom_' + Date.now();
  const card = { id, english, pinyin, characters, type, category };
  customCards.push(card);
  allCards.push(card);
  saveCustom();
  buildFilterRow();
  return card;
}

function deleteCustomCard(index) {
  const card = customCards[index];
  customCards.splice(index, 1);
  allCards = allCards.filter(c => c.id !== card.id);
  delete progress[card.id];
  saveCustom();
  saveProgress();
  renderCustomList();
}

// ── Hands-free mode ───────────────────────────────────────────────────────────

function startHandsFreeMode() {
  if (!SpeechRecognition) {
    el.speechStatus.textContent = 'Speech recognition not supported in this browser.';
    return;
  }
  handsFreeActive = true;
  document.getElementById('btn-hf-start').classList.add('hf-active');
  el.frontButtons.classList.add('hidden');
  el.backButtons.classList.add('hidden');
  document.getElementById('hf-buttons').classList.remove('hidden');
  el.speechResult.className = 'hidden';
  hfRunCard();
}

function stopHandsFreeMode() {
  handsFreeActive = false;
  if (hfRecognition) { try { hfRecognition.abort(); } catch (e) {} hfRecognition = null; }
  if (window.speechSynthesis) speechSynthesis.cancel();
  document.getElementById('btn-hf-start').classList.remove('hf-active');
  document.getElementById('hf-buttons').classList.add('hidden');
  el.frontButtons.classList.remove('hidden');
  el.backButtons.classList.add('hidden');
  el.speechStatus.textContent = '';
  el.speechResult.className = 'hidden';
  if (cardFlipped) flipCard();
}

function hfRunCard() {
  if (!handsFreeActive) return;
  if (queueIndex >= queue.length) {
    const msg = `Session complete! You got ${sessionCorrect} out of ${queue.length} correct.`;
    el.speechStatus.textContent = msg;
    hfSpeak(msg, 'en-US', () => { stopHandsFreeMode(); showDone(); });
    return;
  }
  renderCard();
  const card = queue[queueIndex];
  const isZhEn = card._direction === 'zh-en';
  el.speechStatus.textContent = '▶ ' + (isZhEn ? card.characters : card.english);
  const promptText = isZhEn ? card.characters : card.english;
  const promptLang = isZhEn ? 'zh-CN' : 'en-US';
  hfSpeak(promptText, promptLang, () => {
    if (!handsFreeActive) return;
    setTimeout(() => hfListen(card), 400);
  });
}

function hfListen(card) {
  if (!handsFreeActive) return;
  el.speechStatus.textContent = '🎙 Listening… (say it or "pass")';

  const isZhEn    = card._direction === 'zh-en';
  const startTime = Date.now();
  let handled     = false;

  function attempt() {
    if (handled || !handsFreeActive) return;

    hfRecognition = new SpeechRecognition();
    hfRecognition.lang            = isZhEn ? 'en-US' : 'zh-CN';
    hfRecognition.interimResults  = false;
    hfRecognition.maxAlternatives = 3;

    hfRecognition.onresult = (e) => {
      if (handled) return;
      handled = true;
      const alts = Array.from(e.results[0]).map(r => r.transcript.trim());
      const raw  = alts[0].toLowerCase();
      if (raw.includes('pass') || raw.includes('跳') || raw.includes('不知道')) {
        hfHandlePass(card);
      } else if (isZhEn) {
        const correct = alts.some(a =>
          a.toLowerCase().includes(card.english.toLowerCase()) ||
          card.english.toLowerCase().includes(a.toLowerCase())
        );
        hfHandleAnswer(card, correct);
      } else {
        hfHandleAnswer(card, checkSpeechMatch(alts, card.characters));
      }
    };

    hfRecognition.onerror = (e) => {
      if (handled || e.error === 'aborted') return;
      if (e.error === 'no-speech') {
        if (Date.now() - startTime >= 60000) {
          // Full minute elapsed — treat silence as a pass
          handled = true;
          hfHandlePass(card);
        } else {
          // Still within the window — restart and keep waiting
          setTimeout(attempt, 200);
        }
        return;
      }
      handled = true;
      hfHandlePass(card);
    };

    hfRecognition.start();
  }

  attempt();
}

function hfHandlePass(card) {
  if (!handsFreeActive) return;
  playIncorrectSound();
  const isZhEn = card._direction === 'zh-en';
  el.speechStatus.textContent = isZhEn ? `Pass — ${card.english}` : `Pass — ${card.pinyin}`;
  if (!cardFlipped) flipCard();
  progress[pKey(card)] = sm2(progress[pKey(card)], 0);
  saveProgress();
  queueIndex++;
  hfSpeakAnswer(card, () => setTimeout(() => hfRunCard(), 700));
}

function hfHandleAnswer(card, correct) {
  if (!handsFreeActive) return;
  if (!cardFlipped) flipCard();
  progress[pKey(card)] = sm2(progress[pKey(card)], correct ? 1 : 0);
  saveProgress();
  queueIndex++;
  if (correct) {
    playCorrectSound();
    sessionCorrect++;
    el.speechStatus.textContent = '✓ Correct!';
    hfSpeak('Correct!', 'en-US', () => setTimeout(() => hfRunCard(), 500));
  } else {
    playIncorrectSound();
    const isZhEn = card._direction === 'zh-en';
    el.speechStatus.textContent = isZhEn ? `✗ ${card.english}` : `✗ ${card.pinyin}`;
    hfSpeak('Not quite.', 'en-US', () =>
      hfSpeakAnswer(card, () => setTimeout(() => hfRunCard(), 700))
    );
  }
}

// For EN→ZH: speak characters in Chinese only
// For ZH→EN: speak the English answer
function hfSpeakAnswer(card, onEnd) {
  if (card._direction === 'zh-en') {
    hfSpeak(card.english, 'en-US', onEnd);
  } else {
    hfSpeak(card.characters, 'zh-CN', onEnd);
  }
}

// Reliable TTS wrapper — safety timeout guards against onend not firing on mobile
function hfSpeak(text, lang, onEnd) {
  if (!window.speechSynthesis) { setTimeout(onEnd || (() => {}), 300); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = lang === 'zh-CN' ? 0.8 : 0.95;
  let fired = false;
  const done = () => { if (!fired) { fired = true; if (onEnd) onEnd(); } };
  u.onend = done;
  u.onerror = done;
  setTimeout(done, Math.max(2500, text.length * 150));
  speechSynthesis.speak(u);
}

// ── Event listeners ───────────────────────────────────────────────────────────
// Tap card to flip (toggle front ↔ back)
document.getElementById('card').addEventListener('click', () => {
  flipCard();
});

// TTS button
document.getElementById('btn-tts').addEventListener('click', (e) => {
  e.stopPropagation();
  speak(queue[queueIndex].characters);
});

// Speak button
document.getElementById('btn-speak').addEventListener('click', (e) => {
  e.stopPropagation();
  startSpeech();
});

// Reveal button — only flips forward (it's hidden once on the back side)
document.getElementById('btn-reveal').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!cardFlipped) flipCard();
});

// Grade buttons — speech highlights a suggestion, user's tap is always the final grade
document.getElementById('back-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('.grade-btn');
  if (!btn) return;
  gradeCard(parseInt(btn.dataset.grade, 10));
});

// Hands-free buttons
document.getElementById('btn-hf-start').addEventListener('click', () => {
  if (handsFreeActive) stopHandsFreeMode();
  else startHandsFreeMode();
});
document.getElementById('btn-hf-stop').addEventListener('click', () => stopHandsFreeMode());

// Info modal
document.getElementById('btn-info').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('modal-info').classList.remove('hidden');
});
document.getElementById('btn-info-close').addEventListener('click', () => {
  document.getElementById('modal-info').classList.add('hidden');
});
document.querySelector('.modal-backdrop').addEventListener('click', () => {
  document.getElementById('modal-info').classList.add('hidden');
});

// Direction row
document.getElementById('direction-row').addEventListener('click', (e) => {
  const btn = e.target.closest('.dir-btn');
  if (!btn) return;
  activeDirection = btn.dataset.dir;
  document.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  buildSession();
  if (queue.length === 0) showDone();
  else { showScreen('study'); renderCard(); }
});

// Filter row
document.getElementById('filter-row').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  activeCategory = btn.dataset.category;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  buildSession();
  if (queue.length === 0) showDone();
  else { showScreen('study'); renderCard(); }
});

// Add card nav button
document.getElementById('btn-add-nav').addEventListener('click', () => {
  renderCustomList();
  showScreen('add');
});

document.getElementById('btn-add-from-done').addEventListener('click', () => {
  renderCustomList();
  showScreen('add');
});

// Back button in add screen
document.getElementById('btn-back').addEventListener('click', () => {
  if (queue.length === 0 || queueIndex >= queue.length) {
    showDone();
  } else {
    showScreen('study');
  }
});

// Add card form submit
document.getElementById('add-card-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const english    = el.newEnglish.value.trim();
  const pinyin     = el.newPinyin.value.trim();
  const characters = el.newChars.value.trim();
  const type       = el.newType.value;
  const category   = document.getElementById('new-category').value;

  if (!english || !pinyin || !characters) return;

  addCustomCard(english, pinyin, characters, type, category);

  // Reset form
  el.newEnglish.value = '';
  el.newPinyin.value  = '';
  el.newChars.value   = '';

  renderCustomList();
  el.newEnglish.focus();
});

// Delete custom card
document.getElementById('custom-card-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-delete');
  if (!btn) return;
  deleteCustomCard(parseInt(btn.dataset.index, 10));
});

// ── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
