// --- 1. 初始化與設定 ---
const supabaseUrl = 'https://gceaxslljccatxvvohtx.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdjZWF4c2xsamNjYXR4dnZvaHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3OTI1ODAsImV4cCI6MjA4NjM2ODU4MH0.QJvdg8gYt_zX8HN7rfylt2UrgNhJ8HeldygRkaVhEX8';

// 將變數名稱改為 _supabase 避開與全域變數名稱衝突
const _supabase = supabase.createClient(supabaseUrl, supabaseKey);

let state = {
    userId: localStorage.getItem('userId') || 'user_' + Math.random().toString(36).substr(2, 9),
    group: localStorage.getItem('group') || (Math.random() > 0.5 ? 'One-way' : 'Two-way'),
    currentTrial: parseInt(localStorage.getItem('currentTrial')) || 0,
    trials: [], 
    startTime: null,
    clickCount: 0
};

// 儲存用戶 ID 與組別
localStorage.setItem('userId', state.userId);
localStorage.setItem('group', state.group);

// --- 2. 實驗演算法 ---
function generateTrials() {
    // 確保 stimuli.js 已經載入
    if (typeof STIMULI_POOL === 'undefined') {
        console.error("錯誤：找不到 STIMULI_POOL，請檢查 stimuli.js 是否正確引入。");
        return [];
    }
    
    let allTrials = [...STIMULI_POOL];
    
    // 依 Stage 分組並在組內隨機排序
    let stage1 = allTrials.filter(t => t.stage === 1).sort(() => 0.5 - Math.random());
    let stage2 = allTrials.filter(t => t.stage === 2).sort(() => 0.5 - Math.random());
    let stage3 = allTrials.filter(t => t.stage === 3).sort(() => 0.5 - Math.random());

    return [...stage1, ...stage2, ...stage3];
}

// --- 3. UI 渲染邏輯 ---
function loadTrial() {
    if (state.currentTrial >= 60) {
        document.getElementById('experiment-container').innerHTML = `
            <div class="text-center py-10">
                <h2 class="text-2xl font-bold text-green-600">實驗已完成</h2>
                <p class="mt-4 text-gray-600">感謝您的參與，數據已安全上傳。</p>
            </div>
        `;
        return;
    }

    const trial = state.trials[state.currentTrial];
    document.getElementById('stimulus-content').innerText = trial.content;
    
    const box = document.getElementById('ai-suggestion-box');
    box.classList.add('hidden');
    document.getElementById('action-buttons').classList.add('hidden');
    document.getElementById('custom-options').classList.add('hidden');
    
    const progress = (state.currentTrial / 60) * 100;
    document.getElementById('progress-bar').style.width = `${progress}%`;
    document.getElementById('progress-text').innerText = `進度: ${state.currentTrial + 1} / 60`;

    // 顯示 Loading
    box.classList.remove('hidden');
    box.classList.add('animate-pulse');
    box.innerHTML = `<p class="text-sm text-gray-500">系統偵測中...</p>`;

    setTimeout(showAISuggestion, 1200);
}

function showAISuggestion() {
    const trial = state.trials[state.currentTrial];
    const box = document.getElementById('ai-suggestion-box');
    const confidence = Math.floor(Math.random() * (96 - 88 + 1) + 88);
    
    // 組別邏輯判斷
    let aiLabelRaw = (state.group === 'One-way') ? trial.ai_label_oneway : trial.ai_label_twoway;
    const labelDisplay = (aiLabelRaw === 'AI') ? 'AI 生成' : '真人撰寫';
    const colorClass = (aiLabelRaw === 'AI') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700';
    
    box.classList.remove('animate-pulse');
    box.innerHTML = `
        <div class="inline-flex items-center ${colorClass} px-4 py-2 rounded-full font-bold shadow-sm">
            <span class="mr-2">🛡️ 系統建議：[${labelDisplay}]</span>
        </div>
        <p class="mt-2 text-xs text-gray-400">系統信心度：${confidence}%</p>
    `;
    
    document.getElementById('action-buttons').classList.remove('hidden');
    state.startTime = Date.now();
    state.clickCount = 0;
}

// --- 4. 數據紀錄 ---
async function recordResponse(agreedWithAI, customLabel = null) {
    const endTime = Date.now();
    const trial = state.trials[state.currentTrial];
    
    let userFinalChoice = agreedWithAI 
        ? ((state.group === 'One-way') ? trial.ai_label_oneway : trial.ai_label_twoway)
        : (customLabel === 'ai' ? 'AI' : 'Human');

    const data = {
        user_id: state.userId,
        group: state.group,
        stage: trial.stage,
        trial_number: state.currentTrial + 1,
        stimulus_id: trial.id,
        is_ai_generated: trial.actual === 'AI',
        ai_suggestion: (state.group === 'One-way') ? trial.ai_label_oneway : trial.ai_label_twoway,
        user_choice: userFinalChoice,
        is_correct: userFinalChoice === trial.actual,
        response_time: endTime - state.startTime,
        click_count: state.clickCount
    };

    // 儲存到 Supabase
    const { error } = await _supabase.from('experiment_results').insert([data]);
    if (error) console.error('儲存失敗:', error);

    state.currentTrial++;
    localStorage.setItem('currentTrial', state.currentTrial);

    if (state.currentTrial > 0 && state.currentTrial % 20 === 0) {
        document.getElementById('survey-layer').classList.remove('hidden');
    } else {
        loadTrial();
    }
}

function showCustomOptions() {
    state.clickCount++;
    document.getElementById('custom-options').classList.remove('hidden');
}

document.getElementById('survey-form').onsubmit = (e) => {
    e.preventDefault();
    document.getElementById('survey-layer').classList.add('hidden');
    e.target.reset();
    loadTrial();
};

window.onload = () => {
    state.trials = generateTrials();
    if (state.trials.length > 0) {
        document.getElementById('group-display').innerText = `受試組別：${state.group}`;
        loadTrial();
    }
};