// 性能优化：使用 requestAnimationFrame 进行动画
const requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame ||
                            window.webkitRequestAnimationFrame || window.msRequestAnimationFrame;

// 性能优化：使用事件委托
document.addEventListener('DOMContentLoaded', function() {
  // 滚动触发动画
  const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
  };

  const observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('animated');
      }
    });
  }, observerOptions);

  // 观察所有需要滚动触发动画的元素
  document.querySelectorAll('.animate-on-scroll').forEach(function(el) {
    observer.observe(el);
  });

  // 头部滚动效果
  window.addEventListener('scroll', function() {
    const header = document.querySelector('.apple-header');
    if (window.scrollY > 10) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  });

  // 注：平台/任务类型的表单联动统一在下方「创建任务表单提交」的 syncTypeGroups 中处理
});

// ---------- 工作台视图切换 ----------
const VIEW_TITLES = { overview: '工作台', jobs: '任务管理', agents: 'Agent 管理', skills: '技能管理', create: '创建任务' };
function switchView(name) {
  document.querySelectorAll('.wb-view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
  document.querySelectorAll('.wb-nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  const title = document.getElementById('view-title');
  if (title) title.textContent = VIEW_TITLES[name] || name;
  localStorage.setItem('wbView', name);
  window.scrollTo({ top: 0 });
}

// 导入API服务
import apiService from './services/apiService.js?v=13';

// 导入渲染服务
import renderService from './services/renderService.js?v=13';

// 导入工具函数
import { setLoadError, initUserSettings, loadUserSettings } from './utils/helpers.js?v=13';

// 导入组件
import { loadSkillsList, resetSkillsSelection } from './components/SkillSelector.js?v=13';
import { bindNavigationEvents } from './components/Navigation.js?v=13';

// 性能优化：使用 Promise.all 并行请求
async function refresh() {
  try {
    const [s, a, j] = await Promise.all([
      apiService.getSkills(),
      apiService.getAgents(),
      apiService.getJobs()
    ]);
    
    // 性能优化：使用 requestAnimationFrame 进行 DOM 更新
    requestAnimationFrame(() => {
      renderSkills(s);
      renderAgents(a);
      renderJobs(j);
      renderRecentJobs(j);
      renderAgentsMini(a);
      updateRunningCount(j);
      toggleOnboarding(a);
    });
    checkHealth();
  } catch (e) {
    const msg = '加载失败: ' + (e.message || String(e));
    setLoadError('skills', msg);
    setLoadError('agents', msg);
    setLoadError('jobs', msg);
  }
}

// 渲染技能列表
function renderSkills(data) {
  const container = document.getElementById('skills');
  renderService.renderSkills(data, container);
}

// 渲染Agent列表
function renderAgents(data) {
  const container = document.getElementById('agents');
  // 使用虚拟滚动渲染
  renderService.renderAgentsWithVirtualScroll(data, container);
}

// 渲染任务列表
function renderJobs(data) {
  const container = document.getElementById('jobs');
  renderService.renderJobsWithVirtualScroll(data, container);
}

// 首次接入引导：无 Agent 时显示，可手动关闭（记住选择）
function toggleOnboarding(agentsData) {
  const el = document.getElementById('onboarding');
  if (!el) return;
  const dismissed = localStorage.getItem('onboardingDismissed') === '1';
  el.classList.toggle('hidden', dismissed || !!(agentsData && agentsData.items && agentsData.items.length > 0));
}

// 工作台：最近任务（最多 6 条，点击跳任务管理）
function renderRecentJobs(data) {
  renderService.renderRecentJobs(data, document.getElementById('recent-jobs'));
}

// 工作台：Agent 概览（在线数 + 前 4 个实例）
function renderAgentsMini(data) {
  const el = document.getElementById('agents-mini');
  if (!el) return;
  const items = data.items || [];
  if (!items.length) {
    el.innerHTML = '<p class="text-xs text-gray-400">暂无 Agent。运行 unity-agent 后这里会显示在线状态。</p>';
    return;
  }
  const isOnline = x => x.last_seen && (Date.now() / 1000 - x.last_seen) < 60;
  const online = items.filter(isOnline).length;
  let html = `<div class="text-2xl font-semibold">${online}<span class="text-sm text-gray-400"> / ${items.length}</span></div><p class="text-xs text-gray-500 mt-1">在线 Agent 数</p>`;
  html += items.slice(0, 4).map(x => {
    const on = isOnline(x);
    return `<div class="flex items-center justify-between text-xs text-gray-600 mt-2"><span>${on ? '在线' : '离线'} ${x.agent_id}</span><span class="text-gray-400">${x.platform}</span></div>`;
  }).join('');
  el.innerHTML = html;
}

// 工作台：进行中任务计数
function updateRunningCount(data) {
  const el = document.getElementById('running-count');
  if (el) el.textContent = (data.items || []).filter(j => j.status === 'running').length;
}

// 侧栏底部：服务健康状态点
function checkHealth() {
  fetch('/api/health').then(r => r.json()).then(h => {
    const el = document.getElementById('server-status');
    if (el) el.innerHTML = `<span class="inline-block w-2 h-2 rounded-full" style="background:${h.ok ? '#34c759' : '#ff3b30'}"></span> ${h.ok ? '服务正常' : '服务异常'} · ${h.version}`;
  }).catch(() => {
    const el = document.getElementById('server-status');
    if (el) el.innerHTML = '<span class="inline-block w-2 h-2 rounded-full" style="background:#ff3b30"></span> 服务离线';
  });
}

// 轻提示：成功/失败消息插在任务列表顶部，3 秒后淡出
function showToast(type, text) {
  const jobsEl = document.getElementById('jobs');
  const msg = document.createElement('div');
  msg.className = type === 'success'
    ? 'p-3 bg-green-50 text-green-700 rounded-lg mb-4 message-animation'
    : 'p-3 bg-red-50 text-red-700 rounded-lg mb-4 message-animation';
  msg.textContent = text;
  jobsEl.insertBefore(msg, jobsEl.firstChild);
  setTimeout(() => {
    msg.style.opacity = '0';
    msg.style.transform = 'translateX(-20px)';
    msg.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    setTimeout(() => msg.remove(), 300);
  }, 3000);
}

// 创建任务表单提交
document.addEventListener('DOMContentLoaded', function() {
  const createJobForm = document.getElementById('create-job');
  if (createJobForm) {
    // 任务类型切换：只显示对应类型的配置组（小白友好，避免无关字段干扰）
    const typeGroups = { basic: [], ai: ['ai-extra'], airtest: ['airtest-extra'], gpt: ['gpt-extra'], webcheck: ['webcheck-extra'], apicheck: ['apicheck-extra'], apiflow: ['apiflow-extra'], apiload: ['apiload-extra'], unitylog: ['unitylog-extra'], deviceinv: ['deviceinv-extra'], portcheck: ['portcheck-extra'], certcheck: ['certcheck-extra'], dnscheck: ['dnscheck-extra'], gameperf: ['gameperf-extra'] };
    const basicFields = ['field-unity-path', 'field-test-filter'];
    const syncTypeGroups = function() {
      const t = createJobForm.job_type.value;
      Object.values(typeGroups).flat().forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
      (typeGroups[t] || []).forEach(id => document.getElementById(id)?.classList.remove('hidden'));
      // Unity 路径/过滤字段仅基础与 GPT 类型相关
      const showBasic = (t === 'basic' || t === 'gpt');
      basicFields.forEach(id => document.getElementById(id)?.classList.toggle('hidden', !showBasic));
      // 平台联动：内置执行器固定跑在 web 平台
      const builtinOnWeb = ['webcheck', 'apicheck', 'apiflow', 'apiload', 'portcheck', 'certcheck', 'dnscheck'].includes(t);
      const platformSel = createJobForm.platform;
      if (!builtinOnWeb && platformSel.disabled) platformSel.disabled = false;
      if (builtinOnWeb) platformSel.value = 'web';
      if (t === 'gameperf') platformSel.value = 'android';
      platformSel.disabled = builtinOnWeb;
      platformSel.title = builtinOnWeb ? '内置执行器固定使用 web 平台' : '';
      const webExtra = document.getElementById('web-extra');
      if (webExtra) webExtra.classList.toggle('hidden', !(t === 'basic' && createJobForm.platform.value === 'web'));
    };
    createJobForm.job_type.addEventListener('change', syncTypeGroups);
    createJobForm.platform.addEventListener('change', syncTypeGroups);
    syncTypeGroups();

    createJobForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const platform = form.platform.value;
      const jobType = form.job_type.value;
      const rs = form.required_skills.value.trim();

      // 按任务类型组装 extra（与服务端 Agent 执行器协议一致）
      let extra = {};
      let missing = '';
      if (jobType === 'basic') {
        extra = { job_type: 'self_check' };
      } else if (jobType === 'unitylog') {
        extra = { job_type: 'unity_log_scan', max_errors: parseInt(form.ul_max.value, 10) || 0 };
        if (form.ul_path.value.trim()) extra.log_path = form.ul_path.value.trim();
      } else if (jobType === 'deviceinv') {
        extra = { job_type: 'device_inventory' };
      } else if (jobType === 'webcheck') {
        const url = form.wc_url.value.trim();
        if (!url) missing = '网站检查需要填写「检查地址」';
        extra = {
          job_type: 'web_check',
          url,
          expected_status: parseInt(form.wc_status.value, 10) || 200,
          repeat_minutes: parseInt(form.wc_repeat.value, 10) || 0
        };
        if (form.wc_keyword.value.trim()) extra.keyword = form.wc_keyword.value.trim();
      } else if (jobType === 'apicheck') {
        const url = form.ac_url.value.trim();
        if (!url) missing = '接口测试需要填写「接口地址」';
        extra = {
          job_type: 'api_check',
          method: form.ac_method.value,
          url,
          headers: form.ac_headers.value,
          body: form.ac_body.value,
          expected_status: parseInt(form.ac_status.value, 10) || 200,
          repeat_minutes: parseInt(form.ac_repeat.value, 10) || 0,
          insecure_tls: form.ac_insecure.checked
        };
        if (form.ac_keyword.value.trim()) extra.keyword = form.ac_keyword.value.trim();
        if (form.ac_latency.value) extra.latency_ms = parseInt(form.ac_latency.value, 10);
      } else if (jobType === 'apiflow') {
        const stepsJson = form.af_steps.value.trim();
        if (!stepsJson) missing = '接口流程需要填写「步骤定义」';
        extra = {
          job_type: 'api_flow',
          steps_json: stepsJson,
          repeat_minutes: parseInt(form.af_repeat.value, 10) || 0,
          insecure_tls: form.af_insecure.checked
        };
      } else if (jobType === 'apiload') {
        const url = form.al_url.value.trim();
        if (!url) missing = '性能冒烟需要填写「目标地址」';
        extra = {
          job_type: 'api_load',
          url,
          total: parseInt(form.al_total.value, 10) || 50,
          concurrency: parseInt(form.al_concurrency.value, 10) || 5,
          expected_status: parseInt(form.al_status.value, 10) || 200
        };
        if (form.al_p95.value) extra.p95_ms = parseInt(form.al_p95.value, 10);
      } else if (jobType === 'portcheck') {
        const host = form.pc_host.value.trim();
        const port = parseInt(form.pc_port.value, 10) || 0;
        if (!host || port <= 0) missing = '端口检查需要填写「主机」与有效「端口」';
        extra = { job_type: 'port_check', host, port, timeout_ms: parseInt(form.pc_timeout.value, 10) || 3000 };
        if (form.pc_latency.value) extra.latency_ms = parseInt(form.pc_latency.value, 10);
        extra.repeat_minutes = parseInt(form.pc_repeat.value, 10) || 0;
      } else if (jobType === 'certcheck') {
        const host = form.cc_host.value.trim();
        if (!host) missing = '证书检查需要填写「域名」';
        extra = {
          job_type: 'cert_check',
          host,
          port: parseInt(form.cc_port.value, 10) || 443,
          min_days_valid: parseInt(form.cc_days.value, 10) || 14
        };
      } else if (jobType === 'dnscheck') {
        const host = form.dc_host.value.trim();
        if (!host) missing = 'DNS 检查需要填写「域名」';
        extra = { job_type: 'dns_check', hostname: host };
        if (form.dc_ips.value.trim()) extra.expected_ips = form.dc_ips.value.trim();
      } else if (jobType === 'gameperf') {
        const pkg = form.gp_package.value.trim();
        if (!pkg) missing = '游戏性能测试需要填写「游戏包名」';
        extra = {
          job_type: 'game_perf',
          package: pkg,
          duration_s: parseInt(form.gp_duration.value, 10) || 30,
          max_jank_pct: parseInt(form.gp_jank.value, 10) || 20,
          min_fps: parseInt(form.gp_fps.value, 10) || 30
        };
        if (form.gp_launch.value.trim()) extra.launch_activity = form.gp_launch.value.trim();
        if (form.gp_mem.value) extra.max_mem_mb = parseInt(form.gp_mem.value, 10);
        if (form.gp_serial.value.trim()) extra.device_serial = form.gp_serial.value.trim();
      } else if (jobType === 'ai') {
        const prompt = form.ai_prompt.value.trim();
        if (!prompt) missing = 'AI 探索测试需要填写「测试目标」';
        extra = {
          job_type: 'ai_exploratory',
          prompt,
          max_steps: parseInt(form.ai_max_steps.value, 10) || 12
        };
        if (form.ai_serial.value.trim()) extra.device_serial = form.ai_serial.value.trim();
      } else if (jobType === 'airtest') {
        const scriptPath = form.at_script.value.trim();
        if (!scriptPath) missing = 'Airtest 任务需要填写「脚本路径」';
        extra = { job_type: 'airtest', script_path: scriptPath };
        if (form.at_serial.value.trim()) extra.device_serial = form.at_serial.value.trim();
        if (form.at_window.value.trim()) extra.window_title = form.at_window.value.trim();
      } else if (jobType === 'gpt') {
        const prompt = form.gpt_prompt.value.trim();
        if (!prompt) missing = 'GPT 生成需要填写「测试需求」';
        extra = { job_type: 'generate_and_run', prompt };
        if (form.gpt_assembly.value.trim()) extra.unity_assembly = form.gpt_assembly.value.trim();
      }
      if (platform === 'web') {
        const url = form.web_url ? form.web_url.value.trim() : '';
        const browser = form.web_browser ? form.web_browser.value : '';
        if (url) extra.url = url;
        if (browser) extra.browser = browser;
      }
      if (missing) {
        showToast('error', missing);
        return;
      }

      try {
        // 显示加载状态
        const submitButton = form.querySelector('button[type="submit"]');
        submitButton.innerHTML = '<div class="loading-spinner"></div>';
        submitButton.disabled = true;

        const res = await apiService.createJob({
          platform,
          required_skills: rs ? rs.split(',').map(x => x.trim()).filter(Boolean) : null,
          unity_project_path: form.unity_project_path.value || null,
          test_filter: form.test_filter.value || null,
          extra: Object.keys(extra).length ? extra : null
        });

        if (res && res.job_id) {
          // 重置表单
          form.reset();
          // 重置技能选择
          resetSkillsSelection();
          // 类型联动复位
          createJobForm.job_type.dispatchEvent(new Event('change'));

          // 刷新数据
          await refresh();
          showToast('success', '任务创建成功！');
          switchView('jobs');
        }
      } catch (err) {
        showToast('error', '创建任务失败: ' + (err.message || String(err)));
      } finally {
        // 恢复按钮状态
        const submitButton = form.querySelector('button[type="submit"]');
        submitButton.innerHTML = '创建任务';
        submitButton.disabled = false;
      }
    });
  }
});

// 重试：详情区「用相同参数重试」→ 以原参数创建新任务
window.addEventListener('job:retry', async (e) => {
  const job = e.detail || {};
  try {
    await apiService.createJob({
      platform: job.platform,
      required_skills: job.required_skills || null,
      unity_project_path: job.unity_project_path || null,
      test_filter: job.test_filter || null,
      extra: job.extra && Object.keys(job.extra).length ? job.extra : null
    });
    await refresh();
    showToast('success', `任务 #${job.job_id} 已用相同参数重新创建`);
  } catch (err) {
    showToast('error', '重试失败: ' + (err.message || String(err)));
  }
});

// 清理：删除全部终态任务（数据管理）
document.getElementById('cleanup-jobs')?.addEventListener('click', async () => {
  try {
    const res = await apiService.cleanupJobs();
    await refresh();
    showToast('success', `已清理 ${res.removed || 0} 条历史任务`);
  } catch (err) {
    showToast('error', '清理失败: ' + (err.message || String(err)));
  }
});

// 取消：pending/running → cancelled（终态，Agent 迟到的结果不覆盖）
window.addEventListener('job:cancel', async (e) => {
  const job = e.detail || {};
  try {
    await apiService.cancelJob(job.job_id);
    await refresh();
    showToast('success', `任务 #${job.job_id} 已取消`);
  } catch (err) {
    showToast('error', '取消失败: ' + (err.message || String(err)));
  }
});

// 删除任务：从列表移除
window.addEventListener('job:delete', async (e) => {
  const job = e.detail || {};
  try {
    await apiService.deleteJob(job.job_id);
    await refresh();
    showToast('success', `任务 #${job.job_id} 已删除`);
  } catch (err) {
    showToast('error', '删除失败: ' + (err.message || String(err)));
  }
});

// 查看执行记录：加载 Agent 上传的产物（steps.json / 日志尾部）
window.addEventListener('job:artifacts', async (e) => {
  const job = e.detail || {};
  const findTarget = () => document.querySelector(`[data-artifact-target="${job.job_id}"]`);
  let target = findTarget();
  if (!target) return;
  target.innerHTML = '<p class="text-xs text-gray-400">加载执行记录…</p>';
  try {
    const list = await apiService.getArtifacts(job.job_id);
    // 自动刷新会重建详情 DOM，每次写入前重新定位容器
    target = findTarget();
    if (!target) return;
    if (!list.files || list.files.length === 0) {
      target.innerHTML = '<p class="text-xs text-gray-400">该任务没有执行记录（占位任务或 Agent 未上传）。AI 探索与 Airtest 任务的记录会在执行后自动上传。</p>';
      return;
    }
    target.innerHTML = '';
    for (const f of list.files) {
      target = findTarget();
      if (!target) return;
      const head = document.createElement('div');
      head.className = 'text-xs font-medium text-gray-700';
      head.textContent = `${f.name}（${(f.size / 1024).toFixed(1)} KB）`;
      const pre = document.createElement('pre');
      pre.className = 'text-xs bg-gray-900 text-green-200 p-2 rounded overflow-x-auto max-h-48 whitespace-pre-wrap';
      try {
        pre.textContent = await apiService.getArtifactText(job.job_id, f.name);
      } catch (err) {
        pre.textContent = '读取失败: ' + (err.message || err);
        pre.className = pre.className.replace('text-green-200', 'text-red-300');
      }
      target = findTarget();
      if (!target) return;
      target.appendChild(head);
      target.appendChild(pre);
    }
  } catch (err) {
    const msg = (err.message || String(err));
    const t = findTarget();
    if (t) t.innerHTML = msg.includes('404')
      ? '<p class="text-xs text-gray-400">当前编排服务不支持执行记录（需要 Go 版 v2 服务）。</p>'
      : `<p class="text-xs text-red-500">加载失败: ${msg}</p>`;
  }
});

// 页面加载完成后加载技能列表和绑定导航按钮事件
document.addEventListener('DOMContentLoaded', function() {
  loadSkillsList();
  bindNavigationEvents();
  initUserSettings();
  // 工作台导航
  document.querySelectorAll('#wb-nav .wb-nav-item').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) switchView(go.dataset.goto);
  });
  const savedView = localStorage.getItem('wbView');
  if (savedView && VIEW_TITLES[savedView]) switchView(savedView);
  // 引导横幅关闭（记住选择）
  document.getElementById('onboarding-close')?.addEventListener('click', () => {
    localStorage.setItem('onboardingDismissed', '1');
    document.getElementById('onboarding')?.classList.add('hidden');
  });
});
window.addEventListener('goto', (e) => switchView(e.detail));


// 页面加载完成后初始化
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const settings = loadUserSettings();
  refreshTimer = setInterval(refresh, parseInt(settings.refreshInterval) || 5000);
}
window.addEventListener('load', function() {
  // 初始刷新数据
  refresh();
  checkHealth();
  startAutoRefresh();
});
// 设置保存后热生效（无需刷新页面）
window.addEventListener('settings:saved', function() {
  startAutoRefresh();
});
