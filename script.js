// ============================================================
// script.js - 實驗主邏輯
// 實驗設計：2（錯誤方向）× 3（錯誤率）= 6 組 Between-subjects
//   方向：One-way（只有 false_negative）vs Two-way（false_negative + false_positive）
//   錯誤率：5%（每18題1錯）、10%（每18題2錯）、20%（每18題4錯）
//   總題數：54 題（每階段 18 題）
//   信心度：固定 90%
//   量表：每 18 題填一次，共 3 次，每次 4 題
// ============================================================

// --- 1. Supabase 初始化 ---
const supabaseUrl  = 'https://gceaxslljccatxvvohtx.supabase.co';
const supabaseKey  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdjZWF4c2xsamNjYXR4dnZvaHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3OTI1ODAsImV4cCI6MjA4NjM2ODU4MH0.QJvdg8gYt_zX8HN7rfylt2UrgNhJ8HeldygRkaVhEX8';
const _supabase    = supabase.createClient(supabaseUrl, supabaseKey);

// --- 2. 六組實驗條件定義 ---
const EXPERIMENT_GROUPS = [
  { id: 'OW_05', direction: 'One-way', errorRate: 0.05, errorsPerStage: 1 },
  { id: 'OW_10', direction: 'One-way', errorRate: 0.10, errorsPerStage: 2 },
  { id: 'OW_20', direction: 'One-way', errorRate: 0.20, errorsPerStage: 4 },
  { id: 'TW_05', direction: 'Two-way', errorRate: 0.05, errorsPerStage: 1 },
  { id: 'TW_10', direction: 'Two-way', errorRate: 0.10, errorsPerStage: 2 },
  { id: 'TW_20', direction: 'Two-way', errorRate: 0.20, errorsPerStage: 4 },
];

// --- 3. 全域狀態 ---
let state = {
  userId:       localStorage.getItem('userId') || ('user_' + Math.random().toString(36).substr(2, 9)),
  groupConfig:  null,   // 由 assignGroup() 設定
  currentTrial: parseInt(localStorage.getItem('currentTrial')) || 0,
  trials:       [],
  startTime:    null,
  isProcessing: false,
  tempData:     null,
  surveyScores: [],     // 暫存問卷四題的答案
};

localStorage.setItem('userId', state.userId);

// --- 4. 分組邏輯（隨機平均分配） ---
function assignGroup() {
  const saved = localStorage.getItem('groupId');
  if (saved) {
    return EXPERIMENT_GROUPS.find(g => g.id === saved) || EXPERIMENT_GROUPS[0];
  }
  const idx = Math.floor(Math.random() * EXPERIMENT_GROUPS.length);
  const group = EXPERIMENT_GROUPS[idx];
  localStorage.setItem('groupId', group.id);
  return group;
}

// --- 5. 決定每道題的 AI 標籤（核心邏輯） ---
// 規則：
//   - 階段一（stage 1）：所有標籤 100% 正確
//   - 階段二（stage 2）：按錯誤率與方向注入錯誤
//     * One-way：只有 false_negative（AI 被標成 Human）
//     * Two-way：false_negative 與 false_positive 各一半（若奇數誤題，多出的給 false_negative）
//   - 階段三（stage 3）：所有標籤 100% 恢復正確
function buildTrials(groupConfig) {
  const stage1 = STIMULI_POOL.filter(t => t.stage === 1);
  const stage2 = STIMULI_POOL.filter(t => t.stage === 2);
  const stage3 = STIMULI_POOL.filter(t => t.stage === 3);

  // 隨機打亂各階段（保持題數不變）
  const shuffle = arr => arr.sort(() => Math.random() - 0.5);
  const s1 = shuffle([...stage1]);
  const s2 = shuffle([...stage2]);
  const s3 = shuffle([...stage3]);

  // 幫每道題標記最終的 ai_label（要顯示給受試者的標籤）
  function applyCorrectLabel(trials) {
    return trials.map(t => ({ ...t, ai_label: t.actual }));
  }

  // 階段二：決定哪幾題出錯，以及如何出錯
  function applyStage2Errors(trials, groupConfig) {
    const { direction, errorsPerStage } = groupConfig;
    const result = trials.map(t => ({ ...t, ai_label: t.actual, is_error_trial: false }));

    // 依方向分類可錯的候選題
    const fnCandidates = result.filter(t => t.actual === 'AI');    // false_negative：AI→Human
    const fpCandidates = result.filter(t => t.actual === 'Human'); // false_positive：Human→AI

    let fnCount, fpCount;
    if (direction === 'One-way') {
      fnCount = errorsPerStage;
      fpCount = 0;
    } else {
      // Two-way：平均分配，奇數誤題時多給 false_negative
      fpCount = Math.floor(errorsPerStage / 2);
      fnCount = errorsPerStage - fpCount;
    }

    // 從候選題中隨機選出要出錯的題目
    const pickRandom = (arr, n) => shuffle([...arr]).slice(0, n);
    const fnErrors = pickRandom(fnCandidates, Math.min(fnCount, fnCandidates.length));
    const fpErrors = pickRandom(fpCandidates, Math.min(fpCount, fpCandidates.length));

    const fnIds = new Set(fnErrors.map(t => t.id));
    const fpIds = new Set(fpErrors.map(t => t.id));

    return result.map(t => {
      if (fnIds.has(t.id)) return { ...t, ai_label: 'Human', is_error_trial: true, error_type: 'false_negative' };
      if (fpIds.has(t.id)) return { ...t, ai_label: 'AI',    is_error_trial: true, error_type: 'false_positive' };
      return t;
    });
  }

  const trialsWithLabels = [
    ...applyCorrectLabel(s1),
    ...applyStage2Errors(s2, groupConfig),
    ...applyCorrectLabel(s3),
  ];

  return trialsWithLabels;
}

// --- 6. UI 渲染 ---
function loadTrial() {
  const TOTAL = 54;
  if (state.currentTrial >= TOTAL) { showEndScreen(); return; }

  state.isProcessing = false;
  const trial = state.trials[state.currentTrial];

  document.getElementById('stimulus-content').innerHTML =
    `<div class="whitespace-pre-wrap text-gray-800 leading-relaxed text-base">${trial.content}</div>`;

  document.getElementById('ai-suggestion-box').classList.add('hidden');
  document.getElementById('action-buttons').classList.add('hidden');
  document.getElementById('custom-options').classList.add('hidden');

  const pct = (state.currentTrial / TOTAL) * 100;
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-text').innerText = `進度：${state.currentTrial + 1} / ${TOTAL}`;

  setTimeout(showAISuggestion, 1200);
}

function showAISuggestion() {
  const trial = state.trials[state.currentTrial];
  const box = document.getElementById('ai-suggestion-box');

  // 固定信心度 90%
  const CONFIDENCE = 90;
  const isAI       = trial.ai_label === 'AI';
  const labelText  = isAI ? 'AI 生成' : '真人撰寫';
  const colorClass = isAI ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700';

  box.classList.remove('animate-pulse', 'hidden');
  box.innerHTML = `
    <div class="inline-flex items-center ${colorClass} px-4 py-2 rounded-full font-bold shadow-sm">
      <span class="mr-2">🛡️ 系統建議：[${labelText}]</span>
    </div>
    <p class="mt-2 text-xs text-gray-400">系統信心度：${CONFIDENCE}%</p>
  `;
  document.getElementById('action-buttons').classList.remove('hidden');
  state.startTime = Date.now();
}

// --- 7. 記錄回應 ---
async function recordResponse(agreedWithAI, customLabel = null) {
  if (state.isProcessing) return;
  state.isProcessing = true;

  const endTime = Date.now();
  const trial   = state.trials[state.currentTrial];

  // 決定使用者最終選擇
  let userFinalChoice;
  if (agreedWithAI) {
    userFinalChoice = trial.ai_label;
  } else {
    userFinalChoice = customLabel === 'ai' ? 'AI' : 'Human';
  }

  state.tempData = {
    user_id:        state.userId,
    group_id:       state.groupConfig.id,
    direction:      state.groupConfig.direction,
    error_rate:     state.groupConfig.errorRate,
    stage:          trial.stage,
    trial_number:   state.currentTrial + 1,
    stimulus_id:    trial.id,
    is_ai_generated: trial.actual === 'AI',
    ai_label:       trial.ai_label,
    is_error_trial: trial.is_error_trial || false,
    error_type:     trial.error_type || null,
    user_choice:    userFinalChoice,
    agreed_with_ai: agreedWithAI,
    is_correct:     userFinalChoice === trial.actual,
    response_time:  endTime - state.startTime,
    survey_data:    {},
  };

  // 每 18 題觸發問卷（第 18、36、54 題）
  if ((state.currentTrial + 1) % 18 === 0) {
    showSurvey();
  } else {
    await saveData();
  }
}

// --- 8. 四題信任量表 ---
function showSurvey() {
  const overlay = document.getElementById('survey-layer');
  overlay.classList.remove('hidden');
  // 重置進度條
  state.surveyScores = [];
  renderSurveyQuestion(0);
}

const SURVEY_QUESTIONS = [
  '我信任這個 AI 系統對評論真實性的判斷。',
  '我願意依據這個系統的建議做出決定。',
  '我認為這個系統是可靠的。',
  '如果繼續使用，我會採納這個系統的建議。',
];

function renderSurveyQuestion(index) {
  const container = document.getElementById('survey-question-container');
  const qNum = index + 1;
  container.innerHTML = `
    <p class="text-sm text-gray-500 mb-1">題目 ${qNum} / ${SURVEY_QUESTIONS.length}</p>
    <p class="text-base font-medium text-gray-800 mb-4">${SURVEY_QUESTIONS[index]}</p>
    <div class="flex justify-between text-xs text-gray-400 mb-1">
      <span>1 完全不同意</span><span>7 完全同意</span>
    </div>
    <div class="flex gap-2 justify-center mb-6">
      ${[1,2,3,4,5,6,7].map(v => `
        <button onclick="selectSurveyAnswer(${index}, ${v})"
          id="sq-${v}"
          class="w-10 h-10 rounded-full border-2 border-gray-300 text-sm font-bold
                 hover:bg-indigo-100 hover:border-indigo-400 transition">
          ${v}
        </button>`).join('')}
    </div>
  `;
}

function selectSurveyAnswer(index, value) {
  // 視覺回饋
  [1,2,3,4,5,6,7].forEach(v => {
    const btn = document.getElementById(`sq-${v}`);
    if (btn) btn.classList.remove('bg-indigo-500', 'text-white', 'border-indigo-500');
  });
  const chosen = document.getElementById(`sq-${value}`);
  if (chosen) chosen.classList.add('bg-indigo-500', 'text-white', 'border-indigo-500');

  // 暫存後自動跳下一題（稍微延遲讓受試者看到選擇）
  setTimeout(() => {
    state.surveyScores[index] = value;
    if (index + 1 < SURVEY_QUESTIONS.length) {
      renderSurveyQuestion(index + 1);
    } else {
      submitSurvey();
    }
  }, 350);
}

async function submitSurvey() {
  const scores = state.surveyScores;
  const avg    = scores.reduce((a, b) => a + b, 0) / scores.length;

  state.tempData.survey_data = {
    trust_q1: scores[0],
    trust_q2: scores[1],
    trust_q3: scores[2],
    trust_q4: scores[3],
    trust_avg: parseFloat(avg.toFixed(3)),
    phase:     Math.ceil((state.currentTrial + 1) / 18),
  };

  document.getElementById('survey-layer').classList.add('hidden');
  await saveData();
}

// --- 9. 儲存資料 ---
async function saveData() {
  const { error } = await _supabase.from('experiment_results_v2').insert([state.tempData]);
  if (error) console.error('儲存失敗：', error);

  state.currentTrial++;
  localStorage.setItem('currentTrial', state.currentTrial);
  loadTrial();
}

// --- 10. 結束畫面 ---
function showEndScreen() {
  document.getElementById('experiment-container').innerHTML = `
    <div class="text-center py-10">
      <h2 class="text-2xl font-bold text-green-600">🎉 實驗已完成，謝謝您的參與！</h2>
      <p class="mt-4 text-gray-600">
        您的回答對於 AI 信任研究非常有價值。<br>
        現在您可以關閉此頁面。
      </p>
      <div class="mt-6 p-4 bg-gray-50 rounded-lg text-sm text-gray-500">
        <p class="font-medium mb-1">📋 事後說明</p>
        <p>本實驗目的是研究人們對 AI 偵測系統的信任行為。<br>
        實驗中 AI 系統所顯示的部分標籤為刻意設計的錯誤，用以觀察信任變化，並非系統真實表現。感謝您的理解與配合。</p>
      </div>
      <button onclick="resetExperiment()" class="mt-8 text-sm text-blue-500 underline">重新開始（開發測試用）</button>
    </div>
  `;
}

function resetExperiment() {
  localStorage.clear();
  location.reload();
}

// --- 11. 自行判斷按鈕 ---
function showCustomOptions() {
  document.getElementById('custom-options').classList.remove('hidden');
}

// --- 12. 頁面初始化 ---
window.onload = () => {
  state.groupConfig = assignGroup();
  state.trials      = buildTrials(state.groupConfig);

  // 顯示受試者資訊（不揭露組別條件）
  document.getElementById('group-display').innerText =
    `受試代號：${state.userId.toUpperCase()}`;

  loadTrial();
};
