/**
 * MemoriX — app.js
 * Phase 1: Firebase初期化 / JSTユーティリティ / マークダウンパーサー / Firestoreバッチ保存
 *
 * 設計方針:
 *   - Firebase v9 モジュラー SDK (CDN ESM)
 *   - Firestore オフライン永続化を有効化
 *   - 全件読み込み禁止 → meta/stats ドキュメントでカウンターを管理
 *   - JST (UTC+9) 基準で全日付を計算・保存
 *   - フェーズ2〜5 の拡張ポイントをコメントで明示
 */

// ─────────────────────────────────────────────
// Firebase v9 CDN imports
// ─────────────────────────────────────────────
import { initializeApp }                  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  getDoc,
  setDoc,
  getDocs,
  query,
  orderBy,
  limit,
  startAfter,
  where,
  writeBatch,
  serverTimestamp,
  increment,
  Timestamp,
}                                          from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getStorage }                     from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

// ─────────────────────────────────────────────
// !! PLACEHOLDER !! — ここをご自身のFirebase設定に差し替えてください
// ─────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            'YOUR_API_KEY',
  authDomain:        'YOUR_PROJECT_ID.firebaseapp.com',
  projectId:         'YOUR_PROJECT_ID',
  storageBucket:     'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
  appId:             'YOUR_APP_ID',
};

// ─────────────────────────────────────────────
// Firestore コレクション名定数
// ─────────────────────────────────────────────
const COL_CARDS    = 'cards';    // 単語カードドキュメント
const COL_META     = 'meta';     // 集計メタデータ（全件読み込み不要設計の核心）
const DOC_STATS    = 'stats';    // meta/stats: 全体カウンター
const CARDS_PER_PAGE = 20;       // 1ページの取得件数（無料枠保護）

// ─────────────────────────────────────────────
// アプリケーション初期化
// ─────────────────────────────────────────────
let app, db, storage;

function initFirebase() {
  try {
    app = initializeApp(FIREBASE_CONFIG);

    // オフライン永続化（IndexedDB）を有効化 — マルチタブ対応
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });

    storage = getStorage(app);

    setSyncStatus('online');
    console.info('[MemoriX] Firebase initialized ✅');
  } catch (err) {
    console.error('[MemoriX] Firebase init error:', err);
    setSyncStatus('error');
    showToast('Firebase初期化に失敗しました。設定を確認してください。', 'error');
  }
}

// ─────────────────────────────────────────────
// JST ユーティリティ
// ─────────────────────────────────────────────
const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // UTC+9

/**
 * 現在のJST Dateオブジェクトを返す
 * @returns {Date} JST基準のDate
 */
export function nowJST() {
  return new Date(Date.now() + JST_OFFSET_MS);
}

/**
 * Dateを "YYYY-MM-DD" のJST文字列に変換
 * @param {Date} [date] 省略時は現在時刻
 * @returns {string}
 */
export function toJSTDateString(date) {
  const d = date ? new Date(date.getTime() + JST_OFFSET_MS) : nowJST();
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/**
 * 日付文字列 "YYYY-MM-DD" をJST 0:00 のFirestore Timestampに変換
 * @param {string} dateStr
 * @returns {Timestamp}
 */
export function jstDateStrToTimestamp(dateStr) {
  const [y, m, d_] = dateStr.split('-').map(Number);
  // JST 0:00 = UTC -9:00 前日
  const utcMs = Date.UTC(y, m - 1, d_) - JST_OFFSET_MS;
  return Timestamp.fromMillis(utcMs);
}

/**
 * FirestoreのTimestampをJST "YYYY-MM-DD HH:mm" 文字列に変換
 * @param {Timestamp} ts
 * @returns {string}
 */
export function timestampToJSTString(ts) {
  if (!ts) return '–';
  const ms = ts.toMillis ? ts.toMillis() : ts.seconds * 1000;
  const d = new Date(ms + JST_OFFSET_MS);
  const YYYY = d.getUTCFullYear();
  const MM   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const DD   = String(d.getUTCDate()).padStart(2, '0');
  const hh   = String(d.getUTCHours()).padStart(2, '0');
  const mm   = String(d.getUTCMinutes()).padStart(2, '0');
  return `${YYYY}-${MM}-${DD} ${hh}:${mm}`;
}

// ─────────────────────────────────────────────
// 忘却曲線アルゴリズム（フェーズ5 スタブ）
// ─────────────────────────────────────────────
/**
 * 次回学習日をJST基準で算出（SM-2アルゴリズムを想定）
 * Phase 5 で実装。現状はスタブとして翌日を返す。
 *
 * @param {Object} cardData - { interval, easeFactor, repetitions }
 * @param {number} quality  - 回答品質 0〜5
 * @returns {string} "YYYY-MM-DD"
 */
export function calcNextReviewDate(cardData, quality = 3) {
  // TODO: Phase 5 — SM-2 / Anki互換アルゴリズムを実装
  const today = nowJST();
  const nextDay = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  return toJSTDateString(nextDay);
}

// ─────────────────────────────────────────────
// マークダウン表パーサー
// ─────────────────────────────────────────────

/**
 * NotebookLM出力のマークダウン表を解析し、カードオブジェクト配列を返す
 *
 * 対応フォーマット:
 *   | 用語 | 説明 | （任意追加列...）|
 *   |------|------|
 *   | term1 | def1 |
 *
 * @param {string}  rawText    - 貼り付けられたテキスト
 * @param {number}  termCol    - 用語の列番号（1始まり、デフォルト:1）
 * @param {number}  defCol     - 定義の列番号（1始まり、デフォルト:2）
 * @param {string}  subject    - 教科タグ
 * @returns {{ cards: Array, warnings: string[] }}
 */
export function parseMarkdownTable(rawText, termCol = 1, defCol = 2, subject = '') {
  const cards    = [];
  const warnings = [];
  const seen     = new Set(); // 重複チェック用

  if (!rawText || !rawText.trim()) {
    warnings.push('入力テキストが空です');
    return { cards, warnings };
  }

  const lines = rawText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  // マークダウン行をパース: セルを配列で返す
  const parseRow = (line) => {
    return line
      .replace(/^\||\|$/g, '')          // 先頭末尾の | 除去
      .split('|')
      .map(cell => cell.trim());
  };

  // セパレーター行判定 (---|---|...)
  const isSeparator = (line) => /^\|?[\s\-:]+\|/.test(line);

  let headerSkipped = false;
  let lineNum       = 0;

  for (const line of lines) {
    lineNum++;

    // セパレーター行 → ヘッダー終了フラグを立てる
    if (isSeparator(line)) {
      headerSkipped = true;
      continue;
    }

    // マークダウン表行か判定
    if (!line.startsWith('|') && !line.includes('|')) {
      // 表以外のテキスト（見出し等）はスキップ
      continue;
    }

    const cells = parseRow(line);

    // 列数チェック
    const maxCol = Math.max(termCol, defCol);
    if (cells.length < maxCol) {
      warnings.push(`行 ${lineNum}: 列数が不足しています (${cells.length}列 < ${maxCol}列必要)`);
      continue;
    }

    // ヘッダー行はスキップ（セパレーターが来る前の最初の行）
    if (!headerSkipped) {
      headerSkipped = true; // セパレーターなし形式でも1行目はヘッダーとして扱う
      continue;
    }

    const term       = cells[termCol - 1];
    const definition = cells[defCol - 1];

    // 空セルスキップ
    if (!term || !definition) {
      warnings.push(`行 ${lineNum}: 用語または定義が空のためスキップ`);
      continue;
    }

    // 重複チェック
    const key = `${subject}::${term.toLowerCase()}`;
    if (seen.has(key)) {
      warnings.push(`行 ${lineNum}: 重複する用語「${term}」をスキップ`);
      continue;
    }
    seen.add(key);

    // 追加列を optional フィールドとして収集
    const extraCols = {};
    cells.forEach((cell, i) => {
      const colNum = i + 1;
      if (colNum !== termCol && colNum !== defCol && cell) {
        extraCols[`col${colNum}`] = cell;
      }
    });

    // カードオブジェクト構築
    const todayStr = toJSTDateString();
    cards.push({
      term,
      definition,
      subject:     subject || 'general',
      tags:        subject ? [subject] : [],
      extraCols,
      // 忘却曲線フィールド（Phase 5 で活用）
      interval:    1,
      easeFactor:  2.5,
      repetitions: 0,
      nextReviewDate: calcNextReviewDate({}),
      lastStudiedAt:  null,
      studyCount:     0,
      correctCount:   0,
      // 画像フィールド（Phase 4 で活用）
      imageUrl:    null,
      imageThumbUrl: null,
      // タイムスタンプ（Phase 1 で保存）
      createdDateJST: todayStr,
    });
  }

  if (cards.length === 0 && warnings.length === 0) {
    warnings.push('解析可能なカードが見つかりませんでした。フォーマットを確認してください。');
  }

  return { cards, warnings };
}

// ─────────────────────────────────────────────
// Firestoreバッチ保存
// ─────────────────────────────────────────────

/**
 * カード配列をFirestoreにバッチ保存し、metaドキュメントを更新する
 *
 * Firestoreバッチ上限: 500件/回 → 自動チャンク分割
 *
 * meta/stats ドキュメント構造（全件読み込み不要の核心）:
 *   {
 *     totalCards:      number,              // 総カード数
 *     lastImportedAt:  Timestamp,           // 最終インポート日時（JST基準）
 *     subjectCounts:   { [subject]: number },// 教科別カード数
 *     dailyAdded:      { "YYYY-MM-DD": number }, // 日別追加数（Chart.js用）
 *     studiedToday:    number,              // 本日の学習数（Phase 3で更新）
 *     totalStudied:    number,              // 累計学習数
 *   }
 *
 * @param {Array}    cards           - parseMarkdownTable の出力
 * @param {Function} onProgress      - (done, total) => void
 * @returns {Promise<{ saved: number, errors: number }>}
 */
export async function saveCardsToFirestore(cards, onProgress) {
  if (!db) throw new Error('Firestoreが初期化されていません');
  if (!cards || cards.length === 0) return { saved: 0, errors: 0 };

  const BATCH_SIZE  = 499; // Firestore上限500から1引く（meta更新分を含む）
  const cardsCol    = collection(db, COL_CARDS);
  const metaRef     = doc(db, COL_META, DOC_STATS);

  let saved  = 0;
  let errors = 0;

  // subjectCountsの差分集計
  const subjectDelta  = {};
  const todayStr      = toJSTDateString();

  for (const card of cards) {
    subjectDelta[card.subject] = (subjectDelta[card.subject] || 0) + 1;
  }

  // チャンク分割してバッチ書き込み
  const chunks = [];
  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    chunks.push(cards.slice(i, i + BATCH_SIZE));
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const batch = writeBatch(db);

    for (const card of chunk) {
      const cardRef = doc(cardsCol); // 自動ID
      batch.set(cardRef, {
        ...card,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    try {
      await batch.commit();
      saved += chunk.length;
      onProgress?.(saved, cards.length);
    } catch (err) {
      console.error(`[MemoriX] Batch ${ci + 1}/${chunks.length} failed:`, err);
      errors += chunk.length;
    }
  }

  // ── meta/stats ドキュメントを更新（increment でアトミックに集計） ──
  try {
    const metaSnap = await getDoc(metaRef);

    // subjectCounts の increment マップを構築
    const subjectIncrements = {};
    for (const [subject, count] of Object.entries(subjectDelta)) {
      subjectIncrements[`subjectCounts.${subject}`] = increment(count);
    }

    if (metaSnap.exists()) {
      await setDoc(metaRef, {
        totalCards:    increment(saved),
        lastImportedAt: serverTimestamp(),
        [`dailyAdded.${todayStr}`]: increment(saved),
        ...subjectIncrements,
      }, { merge: true });
    } else {
      // 初回作成
      const subjectCounts = {};
      for (const [subject, count] of Object.entries(subjectDelta)) {
        subjectCounts[subject] = count;
      }
      await setDoc(metaRef, {
        totalCards:    saved,
        lastImportedAt: serverTimestamp(),
        subjectCounts,
        dailyAdded:    { [todayStr]: saved },
        studiedToday:  0,
        totalStudied:  0,
      });
    }
    console.info('[MemoriX] meta/stats updated ✅');
  } catch (err) {
    console.error('[MemoriX] meta/stats update failed:', err);
  }

  return { saved, errors };
}

// ─────────────────────────────────────────────
// カード読み込み（ページネーション）
// ─────────────────────────────────────────────

let lastVisible = null; // ページネーション用カーソル

/**
 * カードをページネーションで取得
 * ※全件読み込み禁止 → CARDS_PER_PAGE 件ずつ取得
 *
 * @param {boolean} reset      - trueで最初から取得
 * @param {string}  subject    - 教科フィルター（空文字で全件）
 * @param {string}  searchTerm - 検索テキスト（クライアントサイドフィルター）
 * @returns {Promise<{ items: Array, hasMore: boolean }>}
 */
export async function fetchCardsPaginated(reset = false, subject = '', searchTerm = '') {
  if (!db) return { items: [], hasMore: false };

  if (reset) lastVisible = null;

  try {
    const cardsCol = collection(db, COL_CARDS);

    // クエリ構築（教科フィルター + ページネーション）
    let q;
    if (subject) {
      q = lastVisible
        ? query(cardsCol, where('subject', '==', subject), orderBy('createdAt', 'desc'), startAfter(lastVisible), limit(CARDS_PER_PAGE))
        : query(cardsCol, where('subject', '==', subject), orderBy('createdAt', 'desc'), limit(CARDS_PER_PAGE));
    } else {
      q = lastVisible
        ? query(cardsCol, orderBy('createdAt', 'desc'), startAfter(lastVisible), limit(CARDS_PER_PAGE))
        : query(cardsCol, orderBy('createdAt', 'desc'), limit(CARDS_PER_PAGE));
    }

    const snap = await getDocs(q);
    if (!snap.empty) lastVisible = snap.docs[snap.docs.length - 1];

    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // クライアントサイド検索（Firestoreの全文検索回避）
    if (searchTerm.trim()) {
      const lower = searchTerm.toLowerCase();
      items = items.filter(c =>
        c.term?.toLowerCase().includes(lower) ||
        c.definition?.toLowerCase().includes(lower)
      );
    }

    return { items, hasMore: snap.docs.length === CARDS_PER_PAGE };
  } catch (err) {
    console.error('[MemoriX] fetchCards error:', err);
    return { items: [], hasMore: false };
  }
}

/**
 * meta/stats ドキュメントを取得して統計を返す
 * ※カードコレクションへのアクセス不要 → 無料枠保護
 * @returns {Promise<Object|null>}
 */
export async function fetchStats() {
  if (!db) return null;
  try {
    const snap = await getDoc(doc(db, COL_META, DOC_STATS));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('[MemoriX] fetchStats error:', err);
    return null;
  }
}

// ─────────────────────────────────────────────
// UI ヘルパー
// ─────────────────────────────────────────────

/** トースト通知を表示 */
export function showToast(message, type = 'success', durationMs = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className   = `show ${type}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = ''; }, durationMs);
}

/** Firebase接続ステータスを更新 */
function setSyncStatus(state) {
  const dot   = document.getElementById('sync-dot');
  const label = document.getElementById('sync-label');
  if (!dot || !label) return;
  const map = {
    online:  { color: '#4ade80', text: 'オンライン' },
    offline: { color: '#fb923c', text: 'オフライン' },
    syncing: { color: '#fbbf24', text: '同期中...' },
    error:   { color: '#f87171', text: 'エラー' },
  };
  const s = map[state] || map.offline;
  dot.style.background = s.color;
  label.textContent    = s.text;
}

/** JSTクロックを毎秒更新 */
function startJSTClock() {
  const el = document.getElementById('jst-clock');
  if (!el) return;
  const tick = () => {
    const now = nowJST();
    const hh  = String(now.getUTCHours()).padStart(2, '0');
    const mm  = String(now.getUTCMinutes()).padStart(2, '0');
    const ss  = String(now.getUTCSeconds()).padStart(2, '0');
    el.textContent = `JST ${hh}:${mm}:${ss}`;
  };
  tick();
  setInterval(tick, 1000);
}

// ─────────────────────────────────────────────
// カード一覧レンダリング
// ─────────────────────────────────────────────
function renderCardItem(card) {
  const el = document.createElement('div');
  el.className = 'glass rounded-2xl p-4 shadow-card animate-fade-in hover:border-amber-500/20 transition-colors border border-transparent';
  el.innerHTML = `
    <div class="flex items-start justify-between gap-3">
      <div class="flex-1 min-w-0">
        <p class="font-display font-bold text-white text-sm leading-snug truncate">${escapeHtml(card.term)}</p>
        <p class="text-slate-400 text-xs mt-1 line-clamp-2 leading-relaxed">${escapeHtml(card.definition)}</p>
      </div>
      <div class="flex flex-col items-end gap-1 shrink-0">
        <span class="text-[10px] font-mono px-2 py-0.5 rounded-full border border-amber-500/20 text-amber-400/70">${escapeHtml(card.subject)}</span>
        <span class="text-[10px] text-slate-600 font-mono">${card.createdDateJST || '–'}</span>
      </div>
    </div>
    ${card.nextReviewDate ? `<div class="mt-2 flex items-center gap-1.5">
      <svg class="w-3 h-3 text-sky-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      <span class="text-[10px] text-sky-400/70 font-mono">次回: ${card.nextReviewDate}</span>
    </div>` : ''}
  `;
  return el;
}

function renderSubjectChips(subjects, activeSubject, onSelect) {
  const container = document.getElementById('subject-chips');
  if (!container) return;
  container.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className = `text-xs font-mono px-3 py-1 rounded-full border transition-colors ${
    !activeSubject ? 'border-amber-400 text-amber-400 bg-amber-400/10' : 'border-white/10 text-slate-500 hover:border-white/30'
  }`;
  allBtn.textContent = 'すべて';
  allBtn.addEventListener('click', () => onSelect(''));
  container.appendChild(allBtn);

  for (const subject of subjects) {
    const btn = document.createElement('button');
    btn.className = `text-xs font-mono px-3 py-1 rounded-full border transition-colors ${
      activeSubject === subject ? 'border-amber-400 text-amber-400 bg-amber-400/10' : 'border-white/10 text-slate-500 hover:border-white/30'
    }`;
    btn.textContent = subject;
    btn.addEventListener('click', () => onSelect(subject));
    container.appendChild(btn);
  }
}

function renderStats(stats) {
  const grid = document.getElementById('stats-grid');
  if (!grid) return;

  const items = [
    { label: '総カード数',   value: stats.totalCards ?? 0,       icon: '🃏' },
    { label: '本日の学習',   value: stats.studiedToday ?? 0,     icon: '🔥' },
    { label: '累計学習',     value: stats.totalStudied ?? 0,     icon: '📈' },
    { label: '最終更新',     value: timestampToJSTString(stats.lastImportedAt), icon: '🕐', small: true },
  ];

  grid.innerHTML = items.map(item => `
    <div class="glass rounded-2xl p-4 shadow-card">
      <div class="text-2xl mb-2">${item.icon}</div>
      <div class="font-display font-black ${item.small ? 'text-sm' : 'text-2xl'} text-white">${item.value}</div>
      <div class="text-xs text-slate-500 mt-1 font-mono">${item.label}</div>
    </div>
  `).join('');

  // 教科別内訳
  if (stats.subjectCounts && Object.keys(stats.subjectCounts).length > 0) {
    const subSection = document.createElement('div');
    subSection.className = 'col-span-2 glass rounded-2xl p-4 shadow-card';
    subSection.innerHTML = `
      <p class="text-xs font-mono text-slate-500 uppercase tracking-widest mb-3">教科別カード数</p>
      <div class="space-y-2">
        ${Object.entries(stats.subjectCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([subject, count]) => {
            const pct = Math.round((count / (stats.totalCards || 1)) * 100);
            return `
              <div>
                <div class="flex justify-between text-xs mb-1">
                  <span class="text-slate-300 font-mono">${escapeHtml(subject)}</span>
                  <span class="text-amber-400 font-mono">${count}</span>
                </div>
                <div class="h-1 bg-navy-700 rounded-full overflow-hidden">
                  <div class="h-full bg-amber-400 rounded-full transition-all duration-700" style="width:${pct}%"></div>
                </div>
              </div>
            `;
          }).join('')}
      </div>
    `;
    grid.appendChild(subSection);
  }
}

// ─────────────────────────────────────────────
// ページナビゲーション
// ─────────────────────────────────────────────
let currentPage = 'import';

function navigateTo(pageId) {
  currentPage = pageId;
  document.querySelectorAll('.page').forEach(el => {
    el.classList.toggle('active', el.id === `page-${pageId}`);
  });
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const isActive = btn.dataset.page === pageId;
    btn.style.color = isActive ? '#fbbf24' : '';
  });

  // ページ別の初期化処理
  if (pageId === 'cards')  loadCardsPage(true);
  if (pageId === 'stats')  loadStatsPage();
}

// ─────────────────────────────────────────────
// カードページ
// ─────────────────────────────────────────────
let activeSubject   = '';
let knownSubjects   = [];

async function loadCardsPage(reset = false) {
  const listEl    = document.getElementById('card-list');
  const emptyEl   = document.getElementById('cards-empty');
  const subtitleEl = document.getElementById('cards-subtitle');
  const loadMoreEl = document.getElementById('btn-load-more');
  if (!listEl) return;

  if (reset) {
    listEl.innerHTML = '';
    knownSubjects    = [];
  }

  const { items, hasMore } = await fetchCardsPaginated(reset, activeSubject);

  // 教科一覧を収集
  items.forEach(c => { if (c.subject && !knownSubjects.includes(c.subject)) knownSubjects.push(c.subject); });
  renderSubjectChips(knownSubjects, activeSubject, (s) => {
    activeSubject = s;
    loadCardsPage(true);
  });

  if (items.length === 0 && reset) {
    emptyEl?.classList.remove('hidden');
    subtitleEl && (subtitleEl.textContent = 'カードが見つかりません');
  } else {
    emptyEl?.classList.add('hidden');
    items.forEach(card => listEl.appendChild(renderCardItem(card)));
    subtitleEl && (subtitleEl.textContent = `${items.length} 件表示`);
  }

  loadMoreEl && loadMoreEl.classList.toggle('hidden', !hasMore);
}

// ─────────────────────────────────────────────
// 統計ページ
// ─────────────────────────────────────────────
async function loadStatsPage() {
  const stats = await fetchStats();
  if (stats) {
    renderStats(stats);
  } else {
    const grid = document.getElementById('stats-grid');
    if (grid) grid.innerHTML = '<p class="text-slate-500 text-sm col-span-2 text-center py-8">データがありません</p>';
  }
}

// ─────────────────────────────────────────────
// インポートページ — イベント処理
// ─────────────────────────────────────────────
function initImportPage() {
  const inputEl     = document.getElementById('input-markdown');
  const subjectEl   = document.getElementById('input-subject');
  const termColEl   = document.getElementById('input-col-term');
  const defColEl    = document.getElementById('input-col-def');
  const parseBtn    = document.getElementById('btn-parse');
  const saveBtn     = document.getElementById('btn-save');
  const clearBtn    = document.getElementById('btn-clear-input');
  const previewSec  = document.getElementById('preview-section');
  const previewList = document.getElementById('preview-list');
  const previewCnt  = document.getElementById('preview-count');
  const progressWrap = document.getElementById('progress-wrap');
  const progressBar  = document.getElementById('progress-bar-inner');
  const progressLbl  = document.getElementById('progress-label');

  let parsedCards = [];

  // クリアボタン
  clearBtn?.addEventListener('click', () => {
    if (inputEl) inputEl.value = '';
    previewSec?.classList.add('hidden');
    if (previewList) previewList.innerHTML = '';
    parsedCards = [];
    if (saveBtn) saveBtn.disabled = true;
  });

  // 解析ボタン
  parseBtn?.addEventListener('click', () => {
    const raw     = inputEl?.value || '';
    const subject = subjectEl?.value.trim() || '';
    const termCol = parseInt(termColEl?.value || '1', 10);
    const defCol  = parseInt(defColEl?.value || '2', 10);

    const { cards, warnings } = parseMarkdownTable(raw, termCol, defCol, subject);
    parsedCards = cards;

    // 警告表示
    if (warnings.length > 0) {
      showToast(warnings[0], 'error', 4000);
    }

    if (cards.length === 0) {
      previewSec?.classList.add('hidden');
      if (saveBtn) saveBtn.disabled = true;
      return;
    }

    // プレビューを描画
    if (previewList) previewList.innerHTML = '';
    cards.slice(0, 10).forEach(card => {
      const row = document.createElement('div');
      row.className = 'px-4 py-3 flex gap-3 items-start';
      row.innerHTML = `
        <div class="flex-1 min-w-0">
          <span class="font-display font-bold text-white text-xs">${escapeHtml(card.term)}</span>
          <span class="text-slate-500 text-xs mx-1">→</span>
          <span class="text-slate-400 text-xs">${escapeHtml(card.definition.slice(0, 60))}${card.definition.length > 60 ? '...' : ''}</span>
        </div>
      `;
      previewList?.appendChild(row);
    });
    if (cards.length > 10) {
      const more = document.createElement('div');
      more.className = 'px-4 py-2 text-xs text-slate-600 text-center font-mono';
      more.textContent = `... 他 ${cards.length - 10} 件`;
      previewList?.appendChild(more);
    }

    if (previewCnt) previewCnt.textContent = `${cards.length} 件`;
    previewSec?.classList.remove('hidden');
    if (saveBtn) saveBtn.disabled = false;
    showToast(`${cards.length} 件のカードを解析しました ✅`);
  });

  // 保存ボタン
  saveBtn?.addEventListener('click', async () => {
    if (parsedCards.length === 0) return;

    saveBtn.disabled  = true;
    parseBtn.disabled = true;
    progressWrap?.classList.remove('hidden');
    setSyncStatus('syncing');

    try {
      const { saved, errors } = await saveCardsToFirestore(parsedCards, (done, total) => {
        const pct = Math.round((done / total) * 100);
        if (progressBar) progressBar.style.width = `${pct}%`;
        if (progressLbl) progressLbl.textContent = `${done} / ${total} 件保存中...`;
      });

      setSyncStatus('online');
      showToast(`${saved} 件を保存しました 🎉`);
      if (errors > 0) showToast(`${errors} 件の保存に失敗しました`, 'error');

      // リセット
      if (inputEl) inputEl.value = '';
      if (subjectEl) subjectEl.value = '';
      previewSec?.classList.add('hidden');
      parsedCards = [];
      if (progressBar) progressBar.style.width = '0%';
      if (progressLbl) progressLbl.textContent = '';
      progressWrap?.classList.add('hidden');

    } catch (err) {
      console.error('[MemoriX] save error:', err);
      showToast('保存中にエラーが発生しました', 'error');
      setSyncStatus('error');
    } finally {
      saveBtn.disabled  = false;
      parseBtn.disabled = false;
    }
  });
}

// ─────────────────────────────────────────────
// XSS対策エスケープ
// ─────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─────────────────────────────────────────────
// Service Worker 登録
// ─────────────────────────────────────────────
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(reg => console.info('[MemoriX] SW registered:', reg.scope))
      .catch(err => console.warn('[MemoriX] SW registration failed:', err));
  }
}

// ─────────────────────────────────────────────
// オフライン検知
// ─────────────────────────────────────────────
function watchNetworkStatus() {
  const update = () => setSyncStatus(navigator.onLine ? 'online' : 'offline');
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
}

// ─────────────────────────────────────────────
// メインエントリーポイント
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // 1. Firebase初期化
  initFirebase();

  // 2. Service Worker
  registerServiceWorker();

  // 3. ナビゲーション
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });
  navigateTo('import'); // 初期ページ

  // 4. インポートUI
  initImportPage();

  // 5. カード一覧「さらに読み込む」
  document.getElementById('btn-load-more')?.addEventListener('click', () => {
    loadCardsPage(false);
  });

  // 6. 検索
  let searchTimer;
  document.getElementById('search-input')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadCardsPage(true), 400);
  });

  // 7. JSTクロック
  startJSTClock();

  // 8. ネットワーク監視
  watchNetworkStatus();

  console.info('[MemoriX] App ready 🚀');
});

// ─────────────────────────────────────────────
// 将来フェーズ向け拡張ポイント（スタブエクスポート）
// ─────────────────────────────────────────────

/**
 * [Phase 2] Chart.jsグラフ描画
 * fetchStats() から dailyAdded を読み取り Chart.js に渡す
 * ※ カードコレクションへのアクセス不要
 */
export function initChart() { /* TODO: Phase 2 */ }

/**
 * [Phase 3] Tinder風スワイプUI
 * Touch Event API + touch-action: pan-y でAndroid競合回避
 */
export function initSwipeReview() { /* TODO: Phase 3 */ }

/**
 * [Phase 4] Firebase Storage 画像アップロード
 * Canvas APIでリサイズ圧縮してからStorageにアップ
 * @param {File} file
 * @param {string} cardId
 */
export async function uploadCardImage(file, cardId) { /* TODO: Phase 4 */ }

/**
 * [Phase 5] SM-2忘却曲線で次回学習日を更新
 * @param {string} cardId
 * @param {number} quality 0〜5
 */
export async function updateCardAfterReview(cardId, quality) { /* TODO: Phase 5 */ }
