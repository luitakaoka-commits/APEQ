/**
 * 過去問研究 — app.js  (Phase 1)
 *
 * ★変更点（マスター要件から変更した点）:
 *   1. Firestoreスキーマを固定4フィールドに変更
 *      { no, question, answer, source } ← 旧: { term, definition }
 *   2. 列マッピングUI廃止 → ヘッダー名で自動判定
 *   3. CSVインポート機能追加
 *   4. 手入力フォーム機能追加
 *   5. Firebase初期化を遅延実行（★パフォーマンス改善③）
 *
 * 維持している前提条件:
 *   - Firebase v9 モジュラーSDK (CDN ESM)
 *   - Firestore オフライン永続化（IndexedDB）
 *   - JST (UTC+9) 基準の全日付計算
 *   - meta/stats ドキュメントによる集計（全件読み込み禁止）
 *   - writeBatch の499件チャンク自動分割
 */

// ─────────────────────────────────────────────
// Firebase v9 CDN (ESM)
// ─────────────────────────────────────────────
import { initializeApp } from
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection, doc, getDoc, setDoc, getDocs,
  query, orderBy, limit, startAfter, where,
  writeBatch, serverTimestamp, increment, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getStorage } from
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

// ─────────────────────────────────────────────
// !! PLACEHOLDER !! 実際の値に差し替えてください
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
// 定数
// ─────────────────────────────────────────────
const COL_CARDS     = 'cards';
const COL_META      = 'meta';
const DOC_STATS     = 'stats';
const PAGE_SIZE     = 20;   // 1回の取得件数（無料枠保護）
const BATCH_LIMIT   = 499;  // Firestore上限500 - 1

// ─────────────────────────────────────────────
// ★固定スキーマ定義（ヘッダー名の別名リスト）
//   NotebookLMの出力ヘッダーがここに含まれていれば自動マッピング
// ─────────────────────────────────────────────
const HEADER_MAP = {
  no:       ['no', 'No', 'NO', '番号', 'number', '#'],
  question: ['問題', '問', 'question', 'Question', 'q', 'Q'],
  answer:   ['正解', '答え', '回答', 'answer', 'Answer', 'a', 'A', '解答'],
  source:   ['元ネタ', '出典', '補足', 'source', 'Source', 'note', 'Note', '備考'],
};

// ─────────────────────────────────────────────
// アプリ状態
// ─────────────────────────────────────────────
let db, storage;
let lastVisible   = null;
let activeSubject = '';
let knownSubjects = [];
let csvRawText    = '';     // CSVタブ用バッファ
let parsedCards   = [];     // 解析済みカード（共有）

// ─────────────────────────────────────────────
// ★パフォーマンス改善③: Firebase遅延初期化
//   DOMContentLoaded 後に呼び出し → 初回描画をブロックしない
// ─────────────────────────────────────────────
function initFirebase() {
  try {
    const app = initializeApp(FIREBASE_CONFIG);
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
    storage = getStorage(app);
    setSyncStatus('online');
    console.info('[過去問研究] Firebase initialized ✅');
  } catch (e) {
    console.error('[過去問研究] Firebase init error:', e);
    setSyncStatus('error');
    showToast('Firebase初期化に失敗しました', 'err');
  }
}

// ─────────────────────────────────────────────
// JST ユーティリティ
// ─────────────────────────────────────────────
const JST_MS = 9 * 60 * 60 * 1000;

/** 現在のJST Dateを返す */
function nowJST() {
  return new Date(Date.now() + JST_MS);
}

/** Date → "YYYY-MM-DD"（JST） */
function toJSTDate(d) {
  const t = d ? new Date(d.getTime() + JST_MS) : nowJST();
  return t.toISOString().slice(0, 10);
}

/** FirestoreTimestamp → "YYYY-MM-DD HH:mm"（JST） */
function tsToJST(ts) {
  if (!ts) return '–';
  const ms = ts.toMillis ? ts.toMillis() : ts.seconds * 1000;
  const d  = new Date(ms + JST_MS);
  const p  = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 翌日のJST日付文字列（Phase5の忘却曲線用スタブ） */
function nextReviewDefault() {
  return toJSTDate(new Date(nowJST().getTime() + 86400000));
}

// ─────────────────────────────────────────────
// XSS防止
// ─────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────
// カードオブジェクト生成（共通）
// ─────────────────────────────────────────────
function makeCard({ no = '', question, answer, source = '', subject = '' }) {
  return {
    no:             String(no),
    question:       String(question),
    answer:         String(answer),
    source:         String(source),
    subject:        subject || 'general',
    tags:           subject ? [subject] : [],
    // 忘却曲線フィールド（Phase 5）
    interval:       1,
    easeFactor:     2.5,
    repetitions:    0,
    nextReviewDate: nextReviewDefault(),
    lastStudiedAt:  null,
    studyCount:     0,
    correctCount:   0,
    // 画像（Phase 4）
    imageUrl:       null,
    // 日付
    createdDateJST: toJSTDate(),
  };
}

// ─────────────────────────────────────────────
// ヘッダー名からフィールドキーを解決
// ─────────────────────────────────────────────
function resolveHeaderKey(headerCell) {
  const h = headerCell.trim();
  for (const [key, aliases] of Object.entries(HEADER_MAP)) {
    if (aliases.some(a => a === h || h.includes(a))) return key;
  }
  return null;
}

// ─────────────────────────────────────────────
// マークダウン表パーサー
//   ヘッダー名で自動マッピング（列順不問）
//   不正行・短すぎる行・表でない行を無視
// ─────────────────────────────────────────────
function parseMarkdown(raw, subject) {
  const cards    = [];
  const warnings = [];
  if (!raw?.trim()) return { cards, warnings: ['テキストが空です'] };

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  // 列分割
  const splitRow = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  // セパレーター判定（---形式）
  const isSep = l => /^\|?[\s\-:]+\|/.test(l);

  let colMap  = null;   // { no: 0, question: 1, ... } 列インデックスマップ
  let autoNo  = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 表行か判定
    if (!line.includes('|')) continue;

    // セパレーター → スキップ
    if (isSep(line)) continue;

    const cells = splitRow(line);
    if (cells.length < 2) continue;

    // ヘッダー行の検出（colMapがまだない場合）
    if (!colMap) {
      const map = {};
      cells.forEach((cell, idx) => {
        const key = resolveHeaderKey(cell);
        if (key && !(key in map)) map[key] = idx;
      });
      // question と answer が解決できればヘッダーとして確定
      if ('question' in map && 'answer' in map) {
        colMap = map;
        continue;
      }
      // 解決できなかった場合はデータ行として試みる（次のループで再試行）
      continue;
    }

    // データ行
    const q = cells[colMap.question];
    const a = cells[colMap.answer];
    if (!q || !a) {
      warnings.push(`行 ${i + 1}: 問題または正解が空のためスキップ`);
      continue;
    }

    autoNo++;
    cards.push(makeCard({
      no:      colMap.no != null ? (cells[colMap.no] || autoNo) : autoNo,
      question: q,
      answer:   a,
      source:  colMap.source != null ? (cells[colMap.source] || '') : '',
      subject,
    }));
  }

  if (!colMap) warnings.push('「問題」「正解」列が見つかりませんでした。ヘッダー行を確認してください。');
  if (cards.length === 0 && !warnings.length) warnings.push('解析可能なデータがありませんでした。');

  return { cards, warnings };
}

// ─────────────────────────────────────────────
// CSVパーサー
//   RFC 4180 準拠（ダブルクォート・改行・カンマ含む）
// ─────────────────────────────────────────────
function parseCSV(raw) {
  const rows = [];
  let i = 0;
  const n = raw.length;

  while (i < n) {
    const row = [];
    while (i < n) {
      if (raw[i] === '"') {
        // クォートフィールド
        let cell = '';
        i++; // 開きクォートをスキップ
        while (i < n) {
          if (raw[i] === '"' && raw[i + 1] === '"') { cell += '"'; i += 2; }
          else if (raw[i] === '"') { i++; break; }
          else { cell += raw[i++]; }
        }
        row.push(cell);
        if (raw[i] === ',') i++;
      } else {
        let cell = '';
        while (i < n && raw[i] !== ',' && raw[i] !== '\n' && raw[i] !== '\r') {
          cell += raw[i++];
        }
        row.push(cell.trim());
        if (raw[i] === ',') i++;
      }
      if (i >= n || raw[i] === '\n' || raw[i] === '\r') break;
    }
    // 改行スキップ
    if (raw[i] === '\r') i++;
    if (raw[i] === '\n') i++;
    if (row.some(c => c !== '')) rows.push(row);
  }
  return rows;
}

function csvToCards(raw, subject) {
  const cards    = [];
  const warnings = [];
  if (!raw?.trim()) return { cards, warnings: ['CSVが空です'] };

  const rows = parseCSV(raw);
  if (rows.length < 2) return { cards, warnings: ['ヘッダー行を含め2行以上必要です'] };

  // ヘッダー行からcolMap
  const headers = rows[0];
  const colMap  = {};
  headers.forEach((h, idx) => {
    const key = resolveHeaderKey(h);
    if (key && !(key in colMap)) colMap[key] = idx;
  });

  if (!('question' in colMap) || !('answer' in colMap)) {
    return { cards, warnings: ['「問題」「正解」列が見つかりませんでした'] };
  }

  let autoNo = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const q   = row[colMap.question];
    const a   = row[colMap.answer];
    if (!q || !a) { warnings.push(`行 ${r + 1}: 空行スキップ`); continue; }
    autoNo++;
    cards.push(makeCard({
      no:      colMap.no != null ? (row[colMap.no] || autoNo) : autoNo,
      question: q,
      answer:   a,
      source:  colMap.source != null ? (row[colMap.source] || '') : '',
      subject,
    }));
  }
  return { cards, warnings };
}

// ─────────────────────────────────────────────
// プレビュー描画（共通）
// ─────────────────────────────────────────────
function showPreview(cards, warnings) {
  const wrap     = document.getElementById('preview-wrap');
  const listEl   = document.getElementById('preview-list');
  const countEl  = document.getElementById('preview-count');
  const warnEl   = document.getElementById('warn-list');
  const saveBtn  = document.getElementById('btn-save');

  listEl.innerHTML = '';
  warnEl.innerHTML = '';

  if (cards.length === 0) {
    wrap.classList.add('hidden');
    if (warnings.length) showToast(warnings[0], 'err', 4000);
    return;
  }

  // プレビュー最大10件
  cards.slice(0, 10).forEach(c => {
    const row = document.createElement('div');
    row.className = 'px-4 py-3';
    row.innerHTML = `
      <div class="flex items-start gap-2">
        <span class="text-2xs text-slate-600 font-mono mt-0.5 shrink-0 w-5 text-right">${esc(c.no)}</span>
        <div class="flex-1 min-w-0">
          <p class="text-xs font-bold text-slate-200 leading-snug">${esc(c.question)}</p>
          <p class="text-xs text-amber-400/80 mt-0.5">${esc(c.answer)}</p>
          ${c.source ? `<p class="text-2xs text-slate-600 mt-0.5">${esc(c.source)}</p>` : ''}
        </div>
      </div>`;
    listEl.appendChild(row);
  });
  if (cards.length > 10) {
    const more = document.createElement('div');
    more.className = 'px-4 py-2 text-2xs text-slate-600 text-center font-mono';
    more.textContent = `… 他 ${cards.length - 10} 件`;
    listEl.appendChild(more);
  }

  // 警告
  if (warnings.length) {
    warnEl.classList.remove('hidden');
    warnings.forEach(w => {
      const p = document.createElement('p');
      p.className = 'text-2xs text-yellow-500/80 font-mono';
      p.textContent = '⚠ ' + w;
      warnEl.appendChild(p);
    });
  } else {
    warnEl.classList.add('hidden');
  }

  countEl.textContent = `${cards.length} 件`;
  saveBtn.disabled    = false;
  wrap.classList.remove('hidden');
  parsedCards = cards;
}

// ─────────────────────────────────────────────
// Firestore バッチ保存
// ─────────────────────────────────────────────
async function saveToFirestore(cards, onProgress) {
  if (!db) throw new Error('Firestore未初期化');
  if (!cards.length) return { saved: 0, errors: 0 };

  const colRef    = collection(db, COL_CARDS);
  const metaRef   = doc(db, COL_META, DOC_STATS);
  const todayStr  = toJSTDate();
  let saved  = 0;
  let errors = 0;
  const subjectDelta = {};
  cards.forEach(c => { subjectDelta[c.subject] = (subjectDelta[c.subject] || 0) + 1; });

  // チャンク分割
  for (let i = 0; i < cards.length; i += BATCH_LIMIT) {
    const chunk = cards.slice(i, i + BATCH_LIMIT);
    const batch = writeBatch(db);
    chunk.forEach(card => {
      batch.set(doc(colRef), { ...card, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
    try {
      await batch.commit();
      saved += chunk.length;
      onProgress?.(saved, cards.length);
    } catch (e) {
      console.error('[過去問研究] Batch error:', e);
      errors += chunk.length;
    }
  }

  // meta/stats をアトミックに更新
  try {
    const snap = await getDoc(metaRef);
    const subInc = {};
    Object.entries(subjectDelta).forEach(([s, c]) => { subInc[`subjectCounts.${s}`] = increment(c); });

    if (snap.exists()) {
      await setDoc(metaRef, {
        totalCards:    increment(saved),
        lastImportedAt: serverTimestamp(),
        [`dailyAdded.${todayStr}`]: increment(saved),
        ...subInc,
      }, { merge: true });
    } else {
      const sc = {};
      Object.entries(subjectDelta).forEach(([s, c]) => { sc[s] = c; });
      await setDoc(metaRef, {
        totalCards: saved,
        lastImportedAt: serverTimestamp(),
        subjectCounts: sc,
        dailyAdded: { [todayStr]: saved },
        studiedToday: 0,
        totalStudied: 0,
      });
    }
  } catch (e) {
    console.error('[過去問研究] meta/stats error:', e);
  }

  return { saved, errors };
}

// ─────────────────────────────────────────────
// カード取得（ページネーション）
// ─────────────────────────────────────────────
async function fetchCards(reset = false, subject = '', search = '') {
  if (!db) return { items: [], hasMore: false };
  if (reset) lastVisible = null;

  try {
    const col = collection(db, COL_CARDS);
    const constraints = [orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
    if (subject) constraints.unshift(where('subject', '==', subject));
    if (lastVisible) constraints.push(startAfter(lastVisible));

    const snap = await getDocs(query(col, ...constraints));
    if (!snap.empty) lastVisible = snap.docs[snap.docs.length - 1];

    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (search.trim()) {
      const s = search.toLowerCase();
      items = items.filter(c =>
        c.question?.toLowerCase().includes(s) ||
        c.answer?.toLowerCase().includes(s) ||
        c.source?.toLowerCase().includes(s)
      );
    }
    return { items, hasMore: snap.docs.length === PAGE_SIZE };
  } catch (e) {
    console.error('[過去問研究] fetchCards:', e);
    return { items: [], hasMore: false };
  }
}

/** meta/stats を取得 */
async function fetchStats() {
  if (!db) return null;
  try {
    const snap = await getDoc(doc(db, COL_META, DOC_STATS));
    return snap.exists() ? snap.data() : null;
  } catch { return null; }
}

// ─────────────────────────────────────────────
// UI: トースト・ステータス
// ─────────────────────────────────────────────
function showToast(msg, type = 'ok', ms = 2800) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = `show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; }, ms);
}

function setSyncStatus(state) {
  const dot = document.getElementById('sync-dot');
  const lbl = document.getElementById('sync-lbl');
  const m = { online:'#4ade80', offline:'#fb923c', syncing:'#fbbf24', error:'#f87171' };
  const t = { online:'オンライン', offline:'オフライン', syncing:'同期中...', error:'エラー' };
  if (dot) dot.style.background = m[state] || m.offline;
  if (lbl) lbl.textContent      = t[state] || '–';
}

// ─────────────────────────────────────────────
// UI: 保存共通フロー
// ─────────────────────────────────────────────
async function runSave() {
  if (!parsedCards.length) return;
  const saveBtn  = document.getElementById('btn-save');
  const progWrap = document.getElementById('prog-wrap');
  const progBar  = document.getElementById('prog-inner');
  const progLbl  = document.getElementById('prog-lbl');
  const parseBtn = document.getElementById('btn-parse');

  saveBtn.disabled  = true;
  if (parseBtn) parseBtn.disabled = true;
  progWrap.classList.remove('hidden');
  setSyncStatus('syncing');

  try {
    const { saved, errors } = await saveToFirestore(parsedCards, (done, total) => {
      const pct = Math.round(done / total * 100);
      progBar.style.width  = pct + '%';
      progLbl.textContent  = `${done} / ${total} 件保存中...`;
    });

    setSyncStatus('online');
    showToast(`${saved} 件を保存しました 🎉`);
    if (errors) showToast(`${errors} 件失敗`, 'err');

    // リセット
    parsedCards = [];
    document.getElementById('preview-wrap').classList.add('hidden');
    progWrap.classList.add('hidden');
    progBar.style.width = '0%';

  } catch (e) {
    console.error(e);
    showToast('保存中にエラーが発生しました', 'err');
    setSyncStatus('error');
  } finally {
    saveBtn.disabled  = false;
    if (parseBtn) parseBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────
// UI: カードレンダリング
// ─────────────────────────────────────────────
function renderCard(c) {
  const el = document.createElement('div');
  el.className = 'q-card glass rounded-2xl p-4 border border-transparent';
  el.innerHTML = `
    <div class="flex items-start gap-3">
      <span class="text-2xs text-slate-600 font-mono mt-0.5 w-5 text-right shrink-0">${esc(c.no || '–')}</span>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-bold text-slate-100 leading-snug">${esc(c.question)}</p>
        <p class="text-xs text-amber-400/90 mt-1 leading-relaxed">${esc(c.answer)}</p>
        ${c.source ? `<p class="text-2xs text-slate-600 mt-1">${esc(c.source)}</p>` : ''}
      </div>
      <div class="shrink-0 flex flex-col items-end gap-1">
        <span class="text-2xs font-mono px-2 py-0.5 rounded-full border border-white/8 text-slate-500">${esc(c.subject)}</span>
        <span class="text-2xs text-slate-700 font-mono">${c.createdDateJST || '–'}</span>
      </div>
    </div>
    ${c.nextReviewDate ? `
    <div class="flex items-center gap-1 mt-2 ml-8">
      <svg class="w-3 h-3 text-sky-500/60 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      <span class="text-2xs text-sky-500/50 font-mono">次回: ${c.nextReviewDate}</span>
    </div>` : ''}`;
  return el;
}

function renderChips(subjects, active, onSelect) {
  const el = document.getElementById('subject-chips');
  if (!el) return;
  el.innerHTML = '';
  const mkChip = (label, val) => {
    const b = document.createElement('button');
    const isA = val === active;
    b.className = `text-2xs font-bold px-3 py-1 rounded-full border transition-colors ${
      isA ? 'border-amber-400/60 text-amber-400 bg-amber-400/10'
          : 'border-white/8 text-slate-600 hover:border-white/20 hover:text-slate-400'
    }`;
    b.textContent = label;
    b.addEventListener('click', () => onSelect(val));
    el.appendChild(b);
  };
  mkChip('すべて', '');
  subjects.forEach(s => mkChip(s, s));
}

function renderStats(s) {
  const el = document.getElementById('stats-grid');
  if (!el || !s) return;
  const items = [
    { icon:'🃏', val: s.totalCards    ?? 0, lbl:'総問題数' },
    { icon:'🔥', val: s.studiedToday  ?? 0, lbl:'本日の学習' },
    { icon:'📈', val: s.totalStudied  ?? 0, lbl:'累計学習' },
    { icon:'🕐', val: tsToJST(s.lastImportedAt), lbl:'最終更新', sm:true },
  ];
  el.innerHTML = items.map(i => `
    <div class="glass rounded-2xl p-4">
      <div class="text-2xl mb-1.5">${i.icon}</div>
      <div class="font-black ${i.sm ? 'text-xs' : 'text-2xl'} text-white">${i.val}</div>
      <div class="text-2xs text-slate-500 mt-0.5">${i.lbl}</div>
    </div>`).join('');

  if (s.subjectCounts && Object.keys(s.subjectCounts).length) {
    const sub = document.createElement('div');
    sub.className = 'col-span-2 glass rounded-2xl p-4';
    sub.innerHTML = `
      <p class="text-2xs text-slate-500 uppercase tracking-widest font-bold mb-3">教科別</p>
      <div class="space-y-2">
        ${Object.entries(s.subjectCounts).sort((a,b)=>b[1]-a[1]).map(([k,v]) => {
          const pct = Math.round(v/(s.totalCards||1)*100);
          return `<div>
            <div class="flex justify-between text-2xs mb-1">
              <span class="text-slate-400">${esc(k)}</span>
              <span class="text-amber-400 font-mono">${v}</span>
            </div>
            <div class="h-1 bg-ink-800 rounded-full overflow-hidden">
              <div class="h-full bg-amber-400 rounded-full" style="width:${pct}%"></div>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    el.appendChild(sub);
  }
}

// ─────────────────────────────────────────────
// ページナビゲーション
// ─────────────────────────────────────────────
function navigate(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${id}`));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === id));
  if (id === 'cards') loadCardsPage(true);
  if (id === 'stats') loadStatsPage();
}

// ─────────────────────────────────────────────
// カードページ
// ─────────────────────────────────────────────
async function loadCardsPage(reset = false) {
  const listEl  = document.getElementById('card-list');
  const emptyEl = document.getElementById('cards-empty');
  const subEl   = document.getElementById('cards-sub');
  const moreEl  = document.getElementById('btn-more');
  const search  = document.getElementById('search-inp')?.value || '';
  if (!listEl) return;
  if (reset) { listEl.innerHTML = ''; knownSubjects = []; }

  const { items, hasMore } = await fetchCards(reset, activeSubject, search);
  items.forEach(c => { if (c.subject && !knownSubjects.includes(c.subject)) knownSubjects.push(c.subject); });
  renderChips(knownSubjects, activeSubject, s => { activeSubject = s; loadCardsPage(true); });

  if (!items.length && reset) {
    emptyEl?.classList.remove('hidden');
    if (subEl) subEl.textContent = '問題が見つかりません';
  } else {
    emptyEl?.classList.add('hidden');
    // DocumentFragment でまとめてDOM挿入（★パフォーマンス改善④）
    const frag = document.createDocumentFragment();
    items.forEach(c => frag.appendChild(renderCard(c)));
    listEl.appendChild(frag);
    if (subEl) subEl.textContent = `${items.length} 件表示`;
  }
  moreEl?.classList.toggle('hidden', !hasMore);
}

// 統計ページ
async function loadStatsPage() {
  const s = await fetchStats();
  if (s) renderStats(s);
  else {
    const el = document.getElementById('stats-grid');
    if (el) el.innerHTML = '<p class="col-span-2 text-slate-500 text-sm text-center py-8">データがありません</p>';
  }
}

// ─────────────────────────────────────────────
// Import タブ切り替え
// ─────────────────────────────────────────────
function initImportTabs() {
  const tabs = document.querySelectorAll('.itab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const id = tab.dataset.itab;
      ['text','manual','csv'].forEach(k => {
        document.getElementById(`itab-${k}`)?.classList.toggle('hidden', k !== id);
      });
      // タブ切り替え時にプレビューをリセット
      document.getElementById('preview-wrap')?.classList.add('hidden');
      parsedCards = [];
    });
  });
}

// ─────────────────────────────────────────────
// Import: テキスト貼り付け
// ─────────────────────────────────────────────
function initTextTab() {
  document.getElementById('btn-parse')?.addEventListener('click', () => {
    const raw     = document.getElementById('inp-text')?.value || '';
    const subject = document.getElementById('inp-subject')?.value.trim() || '';
    const { cards, warnings } = parseMarkdown(raw, subject);
    showPreview(cards, warnings);
    if (cards.length) showToast(`${cards.length} 件を解析しました ✅`);
  });
}

// ─────────────────────────────────────────────
// Import: 手入力
// ─────────────────────────────────────────────
function initManualTab() {
  document.getElementById('btn-manual-save')?.addEventListener('click', async () => {
    const q = document.getElementById('m-question')?.value.trim();
    const a = document.getElementById('m-answer')?.value.trim();
    const s = document.getElementById('m-source')?.value.trim() || '';
    const subject = document.getElementById('inp-subject')?.value.trim() || '';

    if (!q || !a) { showToast('問題と正解は必須です', 'err'); return; }

    const card  = makeCard({ question: q, answer: a, source: s, subject });
    const btn   = document.getElementById('btn-manual-save');
    btn.disabled = true;
    setSyncStatus('syncing');
    try {
      const { saved } = await saveToFirestore([card], () => {});
      if (saved) {
        showToast('保存しました ✅');
        document.getElementById('m-question').value = '';
        document.getElementById('m-answer').value   = '';
        document.getElementById('m-source').value   = '';
      }
    } catch { showToast('保存に失敗しました', 'err'); }
    finally { btn.disabled = false; setSyncStatus('online'); }
  });
}

// ─────────────────────────────────────────────
// Import: CSV
// ─────────────────────────────────────────────
function initCsvTab() {
  const fileInput = document.getElementById('csv-file');
  const dropZone  = document.getElementById('csv-drop');
  const fileLabel = document.getElementById('csv-filename');
  const parseBtn  = document.getElementById('btn-csv-parse');

  const loadFile = file => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      csvRawText = e.target.result;
      if (fileLabel) { fileLabel.textContent = file.name; fileLabel.classList.remove('hidden'); }
      if (parseBtn)  parseBtn.disabled = false;
    };
    reader.readAsText(file, 'UTF-8');
  };

  fileInput?.addEventListener('change', e => loadFile(e.target.files[0]));

  // Drag & Drop
  dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone?.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    loadFile(e.dataTransfer.files[0]);
  });

  parseBtn?.addEventListener('click', () => {
    const subject = document.getElementById('inp-subject')?.value.trim() || '';
    const { cards, warnings } = csvToCards(csvRawText, subject);
    showPreview(cards, warnings);
    if (cards.length) showToast(`${cards.length} 件を解析しました ✅`);
  });
}

// ─────────────────────────────────────────────
// JSTクロック（★パフォーマンス改善⑤: requestAnimationFrameではなく1秒インターバルで十分）
// ─────────────────────────────────────────────
function startClock() {
  const el = document.getElementById('jst-clock');
  if (!el) return;
  const tick = () => {
    const d = nowJST();
    const p = n => String(n).padStart(2,'0');
    el.textContent = `JST ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

// ─────────────────────────────────────────────
// Service Worker
// ─────────────────────────────────────────────
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(r => console.info('[SW] registered:', r.scope))
      .catch(e => console.warn('[SW] failed:', e));
  }
}

// ─────────────────────────────────────────────
// エントリーポイント
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // 1. Firebase 初期化（遅延）
  initFirebase();

  // 2. SW
  registerSW();

  // 3. クロック
  startClock();

  // 4. ネットワーク監視
  const netUpdate = () => setSyncStatus(navigator.onLine ? 'online' : 'offline');
  window.addEventListener('online',  netUpdate);
  window.addEventListener('offline', netUpdate);

  // 5. ナビゲーション
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.addEventListener('click', () => navigate(b.dataset.nav));
  });
  navigate('import');

  // 6. インポートUI
  initImportTabs();
  initTextTab();
  initManualTab();
  initCsvTab();

  // 7. 保存ボタン（共通）
  document.getElementById('btn-save')?.addEventListener('click', runSave);

  // 8. カード一覧「さらに読み込む」
  document.getElementById('btn-more')?.addEventListener('click', () => loadCardsPage(false));

  // 9. 検索（デバウンス）
  let searchTimer;
  document.getElementById('search-inp')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadCardsPage(true), 350);
  });

  console.info('[過去問研究] App ready 🚀');
});

// ─────────────────────────────────────────────
// フェーズ2〜5 スタブ（拡張ポイント）
// ─────────────────────────────────────────────
/** [Phase 2] Chart.js グラフ → meta/stats.dailyAdded を使う（全件読み込み不要） */
export function initChart() { /* TODO */ }

/** [Phase 3] Tinder風スワイプUI (touch-action: pan-y でAndroid対応) */
export function initSwipeReview() { /* TODO */ }

/** [Phase 4] Canvas APIで圧縮 → Firebase Storage アップロード */
export async function uploadImage(file, cardId) { /* TODO */ }

/** [Phase 5] SM-2 忘却曲線で nextReviewDate を更新 */
export async function reviewCard(cardId, quality) { /* TODO */ }
