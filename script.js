// --- 1. 初始化與設定 ---
const supabaseUrl = 'YOUR_SUPABASE_URL';
const supabaseKey = 'YOUR_SUPABASE_ANON_KEY';
const supabase = supabase.createClient(supabaseUrl, supabaseKey);

let state = {
    userId: localStorage.getItem('userId') || 'user_' + Math.random().toString(36).substr(2, 9),
    group: localStorage.getItem('group') || (Math.random() > 0.5 ? 'One-way' : 'Two-way'),
    currentTrial: parseInt(localStorage.getItem('currentTrial')) || 0,
    trials: [], // 存放隨機後的 60 題
    startTime: null,
    clickCount: 0
};

// 儲存用戶 ID 與組別
localStorage.setItem('userId', state.userId);
localStorage.setItem('group', state.group);

// --- 2. 實驗演算法：題目抽取與錯誤指派 ---
function generateTrials() {
    // 假設我們有 100 題庫，從中抽 60 題
    let pool = Array.from({length: 100}, (_, i) => ({ id: i, is_ai: i < 50 })); // 50真50AI
    let selected = pool.sort(() => 0.5 - Math.random()).slice(0, 60);

    // 定義各階段錯誤題數 (5%, 10%, 15% 約略值)
    const stageErrors = [1, 2, 3]; 
    
    selected.forEach((trial, index) => {
        const stage = Math.floor(index / 20);
        trial.stage = stage + 1;
        trial.should_fail = false; // 預設 AI 給出正確建議
        
        // 標記該階段哪些序號要出錯 (例如每階段前幾個隨機抽)
        // 這裡僅示範邏輯：在每個階段的前 20 題中隨機挑選 N 題設為 should_fail
    });

    return selected;
}

// --- 3. UI 渲染邏輯 ---
function loadTrial() {
    if (state.currentTrial >= 60) {
        alert("實驗結束，感謝參與！");
        return;
    }

    const trial = state.trials[state.currentTrial];
    document.getElementById('stimulus-content').innerText = `題目內容示例 #${trial.id}：這是一段用於測試的文本...`;
    document.getElementById('ai-suggestion-box').classList.add('hidden');
    document.getElementById('action-buttons').classList.add('hidden');
    document.getElementById('custom-options').classList.add('hidden');
    
    // 更新進度條
    const progress = (state.currentTrial / 60) * 100;
    document.getElementById('progress-bar').style.width = `${progress}%`;
    document.getElementById('progress-text').innerText = `進度: ${state.currentTrial} / 60`;

    // 1.2s 後顯示 AI 建議
    setTimeout(showAISuggestion, 1200);
}

function showAISuggestion() {
    const trial = state.trials[state.currentTrial];
    const box = document.getElementById('ai-suggestion-box');
    const confidence = Math.floor(Math.random() * (96 - 88 + 1) + 88);
    
    // 判斷 AI 建議內容 (核心實驗變數)
    let aiLabel = trial.is_ai ? 'AI 生成' : '真人撰寫';
    
    // 如果這題被指派為「錯誤」，則反轉標籤
    if (trial.should_fail) {
        if (state.group === 'One-way' && trial.is_ai) {
            aiLabel = '真人撰寫'; // 漏判 AI
        } else if (state.group === 'Two-way') {
            aiLabel = trial.is_ai ? '真人撰寫' : 'AI 生成'; // 雙向出錯
        }
    }

    const colorClass = aiLabel === 'AI 生成' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700';
    
    box.innerHTML = `
        <div class="inline-flex items-center ${colorClass} px-4 py-2 rounded-full font-bold">
            <span class="mr-2">🛡️ 系統建議：[${aiLabel}]</span>
        </div>
        <p class="mt-2 text-xs text-gray-400">信心度：${confidence}%</p>
    `;
    
    box.classList.remove('hidden', 'animate-pulse');
    document.getElementById('action-buttons').classList.remove('hidden');
    state.startTime = Date.now();
    state.clickCount = 0;
}

// --- 4. 數據紀錄 ---
async function recordResponse(agreedWithAI, customLabel = null) {
    const endTime = Date.now();
    const trial = state.trials[state.currentTrial];
    
    const data = {
        user_id: state.userId,
        group: state.group,
        stage: trial.stage,
        trial_number: state.currentTrial + 1,
        stimulus_id: trial.id,
        is_ai_generated: trial.is_ai,
        user_choice: agreedWithAI ? 'agree' : customLabel,
        response_time: endTime - state.startTime,
        click_count: state.clickCount
    };

    // 寫入 Supabase
    const { error } = await supabase.from('experiment_results').insert([data]);
    
    if (error) console.error('Error saving:', error);

    // 進入下一題或問卷
    state.currentTrial++;
    localStorage.setItem('currentTrial', state.currentTrial);

    if (state.currentTrial % 20 === 0) {
        document.getElementById('survey-layer').classList.remove('hidden');
    } else {
        loadTrial();
    }
}

// --- 初始化執行  ---
window.onload = () => {
    state.trials = generateTrials(); // 實際應從後端獲取或固定 Seed
    document.getElementById('group-display').innerText = `分組：${state.group}`;
    loadTrial();
};