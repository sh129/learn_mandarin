'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let allCards   = [];
let progress   = {};
let customCards = [];
let queue      = [];
let queueIndex = 0;
let sessionCorrect = 0;
let cardFlipped = false;

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
  buildSession();

  if (queue.length === 0) {
    showDone();
  } else {
    showScreen('study');
    renderCard();
  }
}

// ── Session ───────────────────────────────────────────────────────────────────
function buildSession() {
  const t = today();
  queue = allCards.filter(card => {
    const p = progress[card.id];
    if (!p) return true;
    return p.due <= t;
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

  // Reset UI
  el.card.classList.remove('flipped');
  el.cardFront.classList.remove('hidden');
  el.cardBack.classList.add('hidden');
  el.frontButtons.classList.remove('hidden');
  el.backButtons.classList.add('hidden');
  el.speechResult.classList.add('hidden');
  el.speechResult.className = 'hidden';
  el.speechStatus.textContent = '';

  // Clear grade highlights
  document.querySelectorAll('.grade-btn').forEach(b => b.classList.remove('highlighted'));

  // Front content
  el.cardEnglish.textContent  = card.english;
  el.cardTypeBadge.textContent = card.type === 'phrase' ? 'phrase' : 'word';

  // Back content (pre-populate so flip reveals it)
  el.cardChars.textContent   = card.characters;
  el.cardPinyin.textContent  = card.pinyin;
  el.cardEnSmall.textContent = card.english;

  // Progress
  const done  = queueIndex;
  const total = queue.length;
  el.progressBar.style.width = `${(done / total) * 100}%`;
  el.progressText.textContent = `${done} / ${total}`;
}

function flipCard() {
  if (cardFlipped) return;
  cardFlipped = true;

  el.card.classList.add('flipped');

  setTimeout(() => {
    el.cardFront.classList.add('hidden');
    el.cardBack.classList.remove('hidden');
  }, 150);

  el.frontButtons.classList.add('hidden');
  el.backButtons.classList.remove('hidden');
}

// ── Grading ───────────────────────────────────────────────────────────────────
function gradeCard(level) {
  const card = queue[queueIndex];
  progress[card.id] = sm2(progress[card.id], level);
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

function addCustomCard(english, pinyin, characters, type) {
  const id = 'custom_' + Date.now();
  const card = { id, english, pinyin, characters, type };
  customCards.push(card);
  allCards.push(card);
  saveCustom();
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

// ── Event listeners ───────────────────────────────────────────────────────────
// Tap card front to reveal
document.getElementById('card').addEventListener('click', () => {
  if (!cardFlipped) flipCard();
});

// Speak button
document.getElementById('btn-speak').addEventListener('click', (e) => {
  e.stopPropagation();
  startSpeech();
});

// Reveal button
document.getElementById('btn-reveal').addEventListener('click', (e) => {
  e.stopPropagation();
  flipCard();
});

// Grade buttons — speech highlights a suggestion, user's tap is always the final grade
document.getElementById('back-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('.grade-btn');
  if (!btn) return;
  gradeCard(parseInt(btn.dataset.grade, 10));
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

  if (!english || !pinyin || !characters) return;

  addCustomCard(english, pinyin, characters, type);

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
