
// 时间戳 → 本地化 "YYYY-MM-DD HH:MM:SS"（避免依赖浏览器 locale 的英文格式）
function formatTimestamp(seconds) {
  const d = new Date(seconds * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 渲染服务模块
 * 优化前端数据渲染逻辑，提供高性能的渲染方法
 */

class RenderService {
  constructor() {
    this.renderCache = new Map();
    this.jobFilter = 'all';   // 任务状态筛选：all/running/pending/passed/failed
    this.jobSearch = '';      // 任务搜索关键词
    this._jobsShown = 30;     // 分页：当前显示条数
    this._lastJobs = null;    // 最近一次任务数据，筛选切换时免请求重渲染
    this.expandedJobs = new Set(); // 展开详情的任务 ID
  }

  /**
   * 友好摘要：把 result.summary 的机器字段翻译成用户能读的一句话
   */
  formatSummary(summary) {
    if (!summary) return '';
    if (typeof summary === 'string') return summary;
    const parts = [];
    if (summary.message) parts.push(summary.message);
    if (summary.reason && summary.reason !== summary.message) parts.push(summary.reason);
    if (typeof summary.steps === 'number') parts.push(`${summary.steps} 步`);
    if (summary.model) parts.push(`模型 ${summary.model}`);
    if (parts.length) return parts.join(' · ');
    try {
      const s = JSON.stringify(summary);
      return s.length > 120 ? s.slice(0, 120) + '…' : s;
    } catch (e) { return ''; }
  }

  /**
   * 使用文档片段进行批量DOM操作
   * @param {Function} renderFn - 渲染函数，接收文档片段作为参数
   * @param {HTMLElement} container - 目标容器元素
   */
  renderWithFragment(renderFn, container) {
    const fragment = document.createDocumentFragment();
    renderFn(fragment);
    container.innerHTML = '';
    container.appendChild(fragment);
  }

  /**
   * 渲染技能列表
   * @param {object} data - 技能数据
   * @param {HTMLElement} container - 目标容器元素
   */
  renderSkills(data, container) {
    const cacheKey = `skills_${JSON.stringify(data)}`;
    
    // 检查缓存
    if (this.renderCache.has(cacheKey)) {
      container.innerHTML = this.renderCache.get(cacheKey);
      return;
    }

    this.renderWithFragment((fragment) => {
      if (!data.items || data.items.length === 0) {
        const emptyElement = document.createElement('p');
        emptyElement.className = 'text-gray-500';
        emptyElement.textContent = '暂无 Skills。';
        fragment.appendChild(emptyElement);
        document.getElementById('skill-count').textContent = '0';
        return;
      }

      document.getElementById('skill-count').textContent = data.items.length;

      // 按类别分组
      const skillsByCategory = {};
      data.items.forEach(skill => {
        const category = skill.category || 'other';
        if (!skillsByCategory[category]) {
          skillsByCategory[category] = [];
        }
        skillsByCategory[category].push(skill);
      });

      const labels = { unity: 'Unity', web: 'Web 测试', mobile: 'Mobile', ai: 'AI 测试', devops: 'DevOps', other: '其他' };

      Object.entries(skillsByCategory).forEach(([cat, items]) => {
        const categoryDiv = document.createElement('div');
        categoryDiv.className = 'mb-6';

        const categoryTitle = document.createElement('h3');
        categoryTitle.className = 'text-base font-medium text-gray-900 mb-3';
        categoryTitle.textContent = labels[cat] || cat;
        categoryDiv.appendChild(categoryTitle);

        const skillsContainer = document.createElement('div');
        skillsContainer.className = 'flex flex-wrap gap-2';

        items.forEach(skill => {
          const skillTag = document.createElement('div');
          skillTag.className = 'skill-tag';
          skillTag.innerHTML = `<span>${skill.name}</span>`;
          skillsContainer.appendChild(skillTag);
        });

        categoryDiv.appendChild(skillsContainer);
        fragment.appendChild(categoryDiv);
      });
    }, container);

    // 缓存渲染结果（有上限，防长期驻留内存泄漏）
    if (this.renderCache.size > 40) this.renderCache.clear();
    this.renderCache.set(cacheKey, container.innerHTML);
  }

  /**
   * 渲染Agent列表
   * @param {object} data - Agent数据
   * @param {HTMLElement} container - 目标容器元素
   */
  renderAgents(data, container) {
    const cacheKey = `agents_${JSON.stringify(data)}`;
    
    // 检查缓存
    if (this.renderCache.has(cacheKey)) {
      container.innerHTML = this.renderCache.get(cacheKey);
      return;
    }

    this.renderWithFragment((fragment) => {
      if (!data.items || data.items.length === 0) {
        const emptyElement = document.createElement('p');
        emptyElement.className = 'text-gray-500';
        emptyElement.textContent = '暂无已注册 Agent。请在各环境运行对应 runner 脚本。';
        fragment.appendChild(emptyElement);
        document.getElementById('agent-count').textContent = '0';
        return;
      }

      document.getElementById('agent-count').textContent = data.items.length;

      const agentsContainer = document.createElement('div');
      agentsContainer.className = 'space-y-4';

      data.items.forEach(agent => {
        const agentCard = document.createElement('div');
        agentCard.className = 'p-3 bg-gray-50 rounded-lg transform-layer';

        const agentHeader = document.createElement('div');
        agentHeader.className = 'flex justify-between items-start mb-2';
        
        const online = agent.last_seen && (Date.now() / 1000 - agent.last_seen) < 60;
        const agentId = document.createElement('span');
        agentId.className = 'font-medium text-gray-900 flex items-center gap-1.5';
        const dot = document.createElement('span');
        dot.className = 'inline-block w-2 h-2 rounded-full';
        dot.style.background = online ? '#34c759' : '#c7c7cc';
        dot.title = online ? '在线（60s 内有心跳）' : '离线';
        agentId.appendChild(dot);
        agentId.appendChild(document.createTextNode(agent.agent_id));

        const agentPlatform = document.createElement('span');
        agentPlatform.className = 'text-sm text-gray-500';
        agentPlatform.textContent = `${agent.platform} · ${online ? '在线' : '离线'}`;

        agentHeader.appendChild(agentId);
        agentHeader.appendChild(agentPlatform);

        const skillsContainer = document.createElement('div');
        skillsContainer.className = 'flex flex-wrap gap-2 mb-2';

        if (agent.skills && agent.skills.length) {
          agent.skills.forEach(skill => {
            const skillTag = document.createElement('span');
            skillTag.className = 'text-xs text-gray-600 bg-gray-200 px-2 py-1 rounded';
            skillTag.textContent = skill;
            skillsContainer.appendChild(skillTag);
          });
        } else {
          const noSkillsTag = document.createElement('span');
          noSkillsTag.className = 'text-xs text-gray-500';
          noSkillsTag.textContent = '无技能';
          skillsContainer.appendChild(noSkillsTag);
        }

        const lastSeen = document.createElement('div');
        lastSeen.className = 'text-xs text-gray-500';
        lastSeen.textContent = `最后心跳: ${agent.last_seen ? formatTimestamp(agent.last_seen) : '-'}`;

        agentCard.appendChild(agentHeader);
        agentCard.appendChild(skillsContainer);
        agentCard.appendChild(lastSeen);
        agentsContainer.appendChild(agentCard);
      });

      fragment.appendChild(agentsContainer);
    }, container);

    // 缓存渲染结果（有上限，防长期驻留内存泄漏）
    if (this.renderCache.size > 40) this.renderCache.clear();
    this.renderCache.set(cacheKey, container.innerHTML);
  }

  /**
   * 渲染任务列表
   * @param {object} data - 任务数据
   * @param {HTMLElement} container - 目标容器元素
   */
  renderJobs(data, container) {
    const cacheKey = `jobs_${JSON.stringify(data)}`;
    
    // 检查缓存
    if (this.renderCache.has(cacheKey)) {
      container.innerHTML = this.renderCache.get(cacheKey);
      return;
    }

    this.renderWithFragment((fragment) => {
      if (!data.items || data.items.length === 0) {
        const emptyElement = document.createElement('p');
        emptyElement.className = 'text-gray-500';
        emptyElement.textContent = '暂无任务。';
        fragment.appendChild(emptyElement);
        document.getElementById('job-count').textContent = '0';
        return;
      }

      document.getElementById('job-count').textContent = data.items.length;

      const jobsContainer = document.createElement('div');
      jobsContainer.className = 'space-y-4';

      data.items.forEach(job => {
        let statusClass = 'status-pending';
        let statusText = job.status;

        if (job.status === 'running') {
          statusClass = 'status-running';
        } else if (job.status === 'passed') {
          statusClass = 'status-passed';
        } else if (job.status === 'failed') {
          statusClass = 'status-failed';
        }

        const jobCard = document.createElement('div');
        jobCard.className = 'job-card p-3 bg-gray-50 rounded-lg transform-layer';

        const jobHeader = document.createElement('div');
        jobHeader.className = 'flex justify-between items-start mb-2';
        
        const jobId = document.createElement('span');
        jobId.className = 'font-medium text-gray-900';
        jobId.textContent = `#${job.job_id}`;
        
        const jobStatus = document.createElement('span');
        jobStatus.className = `status-badge ${statusClass}`;
        jobStatus.textContent = statusText;
        
        jobHeader.appendChild(jobId);
        jobHeader.appendChild(jobStatus);

        const jobInfo = document.createElement('div');
        jobInfo.className = 'flex flex-wrap gap-2 mb-2';

        const platformTag = document.createElement('span');
        platformTag.className = 'text-xs text-gray-600 bg-gray-200 px-2 py-1 rounded';
        platformTag.textContent = job.platform;
        jobInfo.appendChild(platformTag);

        if (job.required_skills && job.required_skills.length) {
          job.required_skills.forEach(skill => {
            const skillTag = document.createElement('span');
            skillTag.className = 'text-xs text-gray-600 bg-gray-200 px-2 py-1 rounded';
            skillTag.textContent = `需: ${skill}`;
            jobInfo.appendChild(skillTag);
          });
        }

        if (job.result) {
          const resultInfo = document.createElement('div');
          resultInfo.className = 'text-xs text-gray-500';
          resultInfo.textContent = `结果: ${job.result.success ? '成功' : '失败'}${job.result.summary ? ` · ${JSON.stringify(job.result.summary)}` : ''}`;
          jobCard.appendChild(resultInfo);
        }

        jobCard.appendChild(jobHeader);
        jobCard.appendChild(jobInfo);
        jobsContainer.appendChild(jobCard);
      });

      fragment.appendChild(jobsContainer);
    }, container);

    // 缓存渲染结果（有上限，防长期驻留内存泄漏）
    if (this.renderCache.size > 40) this.renderCache.clear();
    this.renderCache.set(cacheKey, container.innerHTML);
  }

  /**
   * 渲染技能选择列表
   * @param {Array} skills - 技能列表
   * @param {HTMLElement} container - 目标容器元素
   */
  renderSkillsList(skills, container) {
    const cacheKey = `skillsList_${JSON.stringify(skills)}`;
    
    // 检查缓存
    if (this.renderCache.has(cacheKey)) {
      container.innerHTML = this.renderCache.get(cacheKey);
      return;
    }

    this.renderWithFragment((fragment) => {
      if (!skills || skills.length === 0) {
        const emptyElement = document.createElement('div');
        emptyElement.className = 'text-gray-500 text-sm';
        emptyElement.textContent = '暂无技能';
        fragment.appendChild(emptyElement);
        return;
      }

      // 按类别分组
      const skillsByCategory = {};
      skills.forEach(skill => {
        const category = skill.category || 'other';
        if (!skillsByCategory[category]) {
          skillsByCategory[category] = [];
        }
        skillsByCategory[category].push(skill);
      });

      const categoryLabels = { unity: 'Unity', web: 'Web 测试', mobile: 'Mobile', ai: 'AI 测试', devops: 'DevOps', other: '其他' };

      Object.entries(skillsByCategory).forEach(([category, categorySkills]) => {
        const categoryDiv = document.createElement('div');
        categoryDiv.className = 'mb-4';

        const categoryTitle = document.createElement('h4');
        categoryTitle.className = 'text-xs font-medium text-gray-500 uppercase mb-2';
        categoryTitle.textContent = categoryLabels[category] || category;
        categoryDiv.appendChild(categoryTitle);

        const skillsGrid = document.createElement('div');
        skillsGrid.className = 'grid grid-cols-1 md:grid-cols-2 gap-2';

        categorySkills.forEach(skill => {
          const skillItem = document.createElement('div');
          skillItem.className = 'flex items-center py-1';

          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.id = `skill-${skill.id}`;
          checkbox.dataset.skillId = skill.id;
          checkbox.className = 'skill-checkbox mr-3 text-blue-500 focus:ring-blue-200 border-gray-200 rounded';

          const label = document.createElement('label');
          label.htmlFor = `skill-${skill.id}`;
          label.className = 'text-sm text-gray-700 cursor-pointer';
          label.textContent = skill.name;

          skillItem.appendChild(checkbox);
          skillItem.appendChild(label);
          skillsGrid.appendChild(skillItem);
        });

        categoryDiv.appendChild(skillsGrid);
        fragment.appendChild(categoryDiv);
      });
    }, container);

    // 缓存渲染结果（有上限，防长期驻留内存泄漏）
    if (this.renderCache.size > 40) this.renderCache.clear();
    this.renderCache.set(cacheKey, container.innerHTML);
  }

  /**
   * 清除渲染缓存
   * @param {string} key - 缓存键（可选，不提供则清除所有缓存）
   */
  clearCache(key) {
    if (key) {
      this.renderCache.delete(key);
    } else {
      this.renderCache.clear();
    }
  }

  /**
 * 实现虚拟滚动
 * @param {HTMLElement} container - 容器元素
 * @param {Array} items - 数据项
 * @param {Function} renderItem - 单个项目的渲染函数
 * @param {number} itemHeight - 每个项目的高度（像素）
 */
  initVirtualScroll(container, items, renderItem, itemHeight) {
    const containerHeight = container.clientHeight;
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const bufferCount = 2;
    const totalHeight = items.length * itemHeight;

    // 创建虚拟滚动容器
    const virtualContainer = document.createElement('div');
    virtualContainer.style.height = `${totalHeight}px`;
    virtualContainer.style.position = 'relative';

    // 创建可见项目容器
    const visibleContainer = document.createElement('div');
    visibleContainer.style.position = 'absolute';
    visibleContainer.style.top = '0';
    visibleContainer.style.left = '0';
    visibleContainer.style.width = '100%';

    virtualContainer.appendChild(visibleContainer);
    container.innerHTML = '';
    container.appendChild(virtualContainer);

    // 滚动处理函数
    const handleScroll = () => {
      const scrollTop = container.scrollTop;
      const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - bufferCount);
      const endIndex = Math.min(items.length, startIndex + visibleCount + bufferCount * 2);
      const visibleItems = items.slice(startIndex, endIndex);

      // 更新可见项目
      visibleContainer.innerHTML = '';
      visibleContainer.style.transform = `translateY(${startIndex * itemHeight}px)`;

      visibleItems.forEach((item, index) => {
        const itemElement = renderItem(item, startIndex + index);
        itemElement.style.height = `${itemHeight}px`;
        visibleContainer.appendChild(itemElement);
      });
    };

    // 添加滚动事件监听器（使用节流优化）
    container.addEventListener('scroll', this.throttle(handleScroll, 16));
    
    // 初始渲染
    handleScroll();
  }

  /**
   * 渲染带虚拟滚动的Agent列表
   * @param {Object} data - Agent数据
   * @param {HTMLElement} container - 目标容器元素
   */
  renderAgentsWithVirtualScroll(data, container) {
    if (!data.items || data.items.length === 0) {
      const emptyElement = document.createElement('p');
      emptyElement.className = 'text-gray-500';
      emptyElement.textContent = '暂无已注册 Agent。请在各环境运行对应 runner 脚本。';
      container.innerHTML = '';
      container.appendChild(emptyElement);
      document.getElementById('agent-count').textContent = '0';
      return;
    }

    document.getElementById('agent-count').textContent = data.items.length;

    // 使用虚拟滚动
    this.initVirtualScroll(
      container,
      data.items,
      (agent) => {
        const agentCard = document.createElement('div');
        agentCard.className = 'p-3 bg-gray-50 rounded-lg transform-layer';

        const agentHeader = document.createElement('div');
        agentHeader.className = 'flex justify-between items-start mb-2';
        
        const online = agent.last_seen && (Date.now() / 1000 - agent.last_seen) < 60;
        const agentId = document.createElement('span');
        agentId.className = 'font-medium text-gray-900 flex items-center gap-1.5';
        const dot = document.createElement('span');
        dot.className = 'inline-block w-2 h-2 rounded-full';
        dot.style.background = online ? '#34c759' : '#c7c7cc';
        dot.title = online ? '在线（60s 内有心跳）' : '离线';
        agentId.appendChild(dot);
        agentId.appendChild(document.createTextNode(agent.agent_id));

        const agentPlatform = document.createElement('span');
        agentPlatform.className = 'text-sm text-gray-500';
        agentPlatform.textContent = `${agent.platform} · ${online ? '在线' : '离线'}`;

        agentHeader.appendChild(agentId);
        agentHeader.appendChild(agentPlatform);

        const skillsContainer = document.createElement('div');
        skillsContainer.className = 'flex flex-wrap gap-2 mb-2';

        if (agent.skills && agent.skills.length) {
          agent.skills.forEach(skill => {
            const skillTag = document.createElement('span');
            skillTag.className = 'text-xs text-gray-600 bg-gray-200 px-2 py-1 rounded';
            skillTag.textContent = skill;
            skillsContainer.appendChild(skillTag);
          });
        } else {
          const noSkillsTag = document.createElement('span');
          noSkillsTag.className = 'text-xs text-gray-500';
          noSkillsTag.textContent = '无技能';
          skillsContainer.appendChild(noSkillsTag);
        }

        const lastSeen = document.createElement('div');
        lastSeen.className = 'text-xs text-gray-500';
        lastSeen.textContent = `最后心跳: ${agent.last_seen ? formatTimestamp(agent.last_seen) : '-'}`;

        agentCard.appendChild(agentHeader);
        agentCard.appendChild(skillsContainer);
        agentCard.appendChild(lastSeen);

        return agentCard;
      },
      120 // 每个Agent项的高度（像素）
    );
  }

  /**
   * 渲染带虚拟滚动的任务列表
   * @param {Object} data - 任务数据
   * @param {HTMLElement} container - 目标容器元素
   */
  renderJobsWithVirtualScroll(data, container) {
    this._lastJobs = data;
    this.bindJobFilterChips(container);
    this.bindJobSearch(container);

    const kw = (this.jobSearch || '').trim().toLowerCase();
    const all = (data.items || []).slice().sort((a, b) => (b.job_id || 0) - (a.job_id || 0)); // 最新在前
    let items = this.jobFilter === 'all' ? all : all.filter(j => j.status === this.jobFilter);
    if (kw) items = items.filter(j => this.jobMatchesSearch(j, kw));
    const total = items.length;
    const shown = items.slice(0, this._jobsShown || 30);
    document.getElementById('job-count').textContent = all.length;

    if (shown.length === 0) {
      const emptyElement = document.createElement('p');
      emptyElement.className = 'text-gray-500';
      emptyElement.textContent = kw
        ? `没有匹配「${this.jobSearch.trim()}」的任务。`
        : this.jobFilter === 'all'
          ? '暂无任务。在下方「创建任务」提交第一个测试任务吧。'
          : `没有「${this.filterLabel(this.jobFilter)}」状态的任务。`;
      container.innerHTML = '';
      container.appendChild(emptyElement);
      return;
    }

    this.renderWithFragment((fragment) => {
      const jobsContainer = document.createElement('div');
      jobsContainer.className = 'space-y-3';

      shown.forEach(job => {
        const statusClass = `status-${job.status || 'pending'}`;
        const statusText = { pending: '排队中', running: '进行中', passed: '通过', failed: '失败' }[job.status] || job.status;

        const jobCard = document.createElement('div');
        jobCard.className = 'job-card p-3 bg-gray-50 rounded-lg transform-layer cursor-pointer hover:bg-gray-100 transition-colors';
        jobCard.title = '点击展开/收起详情';

        const jobHeader = document.createElement('div');
        jobHeader.className = 'flex justify-between items-start mb-2';

        const jobId = document.createElement('span');
        jobId.className = 'font-medium text-gray-900';
        jobId.textContent = `#${job.job_id}`;

        const jobStatus = document.createElement('span');
        jobStatus.className = `status-badge ${statusClass}`;
        jobStatus.textContent = statusText;

        jobHeader.appendChild(jobId);
        jobHeader.appendChild(jobStatus);

        const jobInfo = document.createElement('div');
        jobInfo.className = 'flex flex-wrap gap-2 mb-2';

        const platformTag = document.createElement('span');
        platformTag.className = 'text-xs text-gray-600 bg-gray-200 px-2 py-1 rounded';
        platformTag.textContent = job.platform;
        jobInfo.appendChild(platformTag);

        const typeNames = { ai_exploratory: 'AI 探索', airtest: 'Airtest', generate_and_run: 'GPT 生成', web_check: '网站检查', api_check: '接口测试', api_flow: '接口流程', api_load: '性能冒烟', self_check: '环境自检', unity_log_scan: '日志扫描', device_inventory: '设备清单', port_check: '端口检查', cert_check: '证书检查', dns_check: 'DNS 检查', game_perf: '游戏性能' };
        const jobType = job.extra && job.extra.job_type;
        if (jobType && typeNames[jobType]) {
          const typeTag = document.createElement('span');
          typeTag.className = 'text-xs text-blue-700 bg-blue-100 px-2 py-1 rounded';
          typeTag.textContent = typeNames[jobType];
          jobInfo.appendChild(typeTag);
        }

        (job.required_skills || []).forEach(skill => {
          const skillTag = document.createElement('span');
          skillTag.className = 'text-xs text-gray-600 bg-gray-200 px-2 py-1 rounded';
          skillTag.textContent = `需: ${skill}`;
          jobInfo.appendChild(skillTag);
        });

        jobCard.appendChild(jobHeader);
        jobCard.appendChild(jobInfo);

        // 一行摘要（友好格式，不再裸奔 JSON）
        if (job.result) {
          const resultInfo = document.createElement('div');
          resultInfo.className = 'text-xs text-gray-500';
          resultInfo.textContent = `${job.result.success ? '✓' : '✗'} ${this.formatSummary(job.result.summary)}`;
          jobCard.appendChild(resultInfo);
        }

        // 点击展开详情
        if (this.expandedJobs.has(job.job_id)) {
          jobCard.appendChild(this.buildJobDetail(job));
        }
        jobCard.addEventListener('click', () => {
          if (this.expandedJobs.has(job.job_id)) {
            this.expandedJobs.delete(job.job_id);
          } else {
            this.expandedJobs.add(job.job_id);
          }
          this.renderJobsWithVirtualScroll(this._lastJobs, container);
        });

        jobsContainer.appendChild(jobCard);
      });

      if (total > shown.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'w-full py-2 text-xs text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors';
        more.textContent = `显示更多（已显示 ${shown.length} / ${total} 条）`;
        more.addEventListener('click', () => {
          this._jobsShown += 50;
          this.renderJobsWithVirtualScroll(this._lastJobs, container);
        });
        jobsContainer.appendChild(more);
      }

      fragment.appendChild(jobsContainer);
    }, container);
  }

  /**
   * 任务搜索匹配：ID / 平台 / 状态 / 类型 / 目标 / 脚本路径 / 所需技能
   */
  jobMatchesSearch(job, kw) {
    const hay = [
      String(job.job_id || ''), job.platform, job.status,
      job.extra && job.extra.job_type, job.extra && job.extra.prompt,
      job.extra && job.extra.script_path, job.unity_project_path, job.test_filter,
      ...(job.required_skills || []),
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(kw);
  }

  /**
   * 绑定搜索框（只绑一次；输入防抖后重置分页并重渲染）
   */
  bindJobSearch(container) {
    const input = document.getElementById('job-search');
    if (!input || input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    const onInput = this.debounce(() => {
      this.jobSearch = input.value;
      this._jobsShown = 30;
      if (this._lastJobs) this.renderJobsWithVirtualScroll(this._lastJobs, container);
    }, 200);
    input.addEventListener('input', onInput);
  }

  /**
   * 工作台：最近任务（最多 6 条，点击跳转任务管理）
   */
  renderRecentJobs(data, container) {
    const items = (data.items || []).slice().sort((a, b) => (b.job_id || 0) - (a.job_id || 0)).slice(0, 6);
    container.innerHTML = '';
    if (!items.length) {
      container.innerHTML = '<p class="text-xs text-gray-400">还没有任务。点击右上角「创建任务」开始第一次测试。</p>';
      return;
    }
    const list = document.createElement('div');
    list.className = 'space-y-2';
    const typeNames = { ai_exploratory: 'AI 探索', airtest: 'Airtest', generate_and_run: 'GPT 生成', web_check: '网站检查', api_check: '接口测试', api_flow: '接口流程', api_load: '性能冒烟', self_check: '环境自检', unity_log_scan: '日志扫描', device_inventory: '设备清单', port_check: '端口检查', cert_check: '证书检查', dns_check: 'DNS 检查', game_perf: '游戏性能' };
    items.forEach(job => {
      const statusText = { pending: '排队中', running: '进行中', passed: '通过', failed: '失败', cancelled: '已取消' }[job.status] || job.status;
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between p-2.5 bg-gray-50 rounded-lg text-sm cursor-pointer hover:bg-gray-100 transition-colors';
      const left = document.createElement('div');
      left.className = 'flex items-center gap-2 min-w-0';
      const idEl = document.createElement('span');
      idEl.className = 'font-medium text-gray-900';
      idEl.textContent = `#${job.job_id}`;
      const stEl = document.createElement('span');
      stEl.className = `status-badge status-${job.status || 'pending'}`;
      stEl.textContent = statusText;
      const pf = document.createElement('span');
      pf.className = 'text-xs text-gray-500';
      pf.textContent = job.platform;
      left.appendChild(idEl);
      left.appendChild(stEl);
      left.appendChild(pf);
      if (job.extra && job.extra.job_type && typeNames[job.extra.job_type]) {
        const t = document.createElement('span');
        t.className = 'text-xs text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded';
        t.textContent = typeNames[job.extra.job_type];
        left.appendChild(t);
      }
      const right = document.createElement('span');
      right.className = 'text-xs text-gray-400 shrink-0';
      right.textContent = job.created_at ? formatTimestamp(job.created_at) : '';
      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener('click', () => window.dispatchEvent(new CustomEvent('goto', { detail: 'jobs' })));
      list.appendChild(row);
    });
    container.appendChild(list);
  }

  filterLabel(status) {
    return { running: '进行中', pending: '排队中', passed: '通过', failed: '失败' }[status] || status;
  }

  /**
   * 绑定任务状态筛选条（只绑一次；切换时用缓存数据立即重渲染）
   */
  bindJobFilterChips(container) {
    const bar = document.getElementById('job-filter');
    if (!bar || bar.dataset.bound === '1') return;
    bar.dataset.bound = '1';
    bar.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-status]');
      if (!chip) return;
      this.jobFilter = chip.dataset.status;
      bar.querySelectorAll('[data-status]').forEach(c => {
        const active = c.dataset.status === this.jobFilter;
        c.classList.toggle('active', active);
        c.classList.toggle('bg-blue-600', active);
        c.classList.toggle('text-white', active);
        c.classList.toggle('border-blue-600', active);
        c.classList.toggle('bg-white', !active);
        c.classList.toggle('text-gray-700', !active);
      });
      if (this._lastJobs) this.renderJobsWithVirtualScroll(this._lastJobs, container);
    });
  }

  /**
   * 任务详情展开块：创建时间、类型专属参数、结果摘要、日志路径
   */
  buildJobDetail(job) {
    const detail = document.createElement('div');
    detail.className = 'mt-2 p-2.5 bg-white rounded border border-gray-100 space-y-1';

    const addLine = (label, value) => {
      if (value === undefined || value === null || value === '') return;
      const line = document.createElement('div');
      line.className = 'text-xs text-gray-600';
      const labelEl = document.createElement('span');
      labelEl.className = 'text-gray-400';
      labelEl.textContent = `${label}: `;
      line.appendChild(labelEl);
      line.appendChild(document.createTextNode(String(value)));
      detail.appendChild(line);
    };

    addLine('创建时间', job.created_at ? formatTimestamp(job.created_at) : '-');
    const extra = job.extra || {};
    addLine('测试目标', extra.prompt);
    addLine('脚本路径', extra.script_path);
    addLine('设备', extra.device_serial);
    addLine('窗口', extra.window_title);
    if (typeof extra.max_steps === 'number') addLine('最大步数', extra.max_steps);
    addLine('Unity 项目', job.unity_project_path);
    addLine('测试过滤', job.test_filter);
    if (extra.generated_test_csharp) {
      const pre = document.createElement('pre');
      pre.className = 'text-xs bg-gray-900 text-green-200 p-2 rounded overflow-x-auto max-h-40';
      pre.textContent = extra.generated_test_csharp.slice(0, 1500);
      detail.appendChild(pre);
    }
    if (extra.generate_error) addLine('生成错误', extra.generate_error);
    if (job.result) {
      addLine('执行 Agent', job.result.agent_id);
      addLine('日志路径', job.result.log_path);
    }
    // 环境自检等断言项（summary.checks 对象）渲染
    if (job.result && job.result.summary && job.result.summary.checks) {
      const box = document.createElement('div');
      box.className = 'mt-1 space-y-1';
      const checks = job.result.summary.checks;
      Object.keys(checks).forEach(k => {
        const v = checks[k];
        let ok = true, text = '';
        if (typeof v === 'boolean') {
          ok = v; text = k;
        } else if (typeof v === 'string') {
          ok = k !== 'storage' || v === '可写';
          text = `${k}: ${v}`;
        } else if (typeof v === 'number') {
          text = `${k}: ${v}`;
        } else if (v && typeof v === 'object') {
          ok = v.ok !== false;
          text = k + (v.error ? `（${v.error}）` : v.body ? ' — 正常' : v.value ? `: ${v.value}` : '');
        }
        const line = document.createElement('div');
        line.className = 'text-xs ' + (ok ? 'text-gray-600' : 'text-red-600');
        line.textContent = `${ok ? '✓' : '✗'} ${text}`;
        box.appendChild(line);
      });
      detail.appendChild(box);
    }

    // 内置检查明细（web_check / api_load 的逐项结果）
    if (job.result && job.result.summary && Array.isArray(job.result.summary.results)) {
      const box = document.createElement('div');
      box.className = 'mt-1 space-y-1';
      job.result.summary.results.forEach(r => {
        const line = document.createElement('div');
        line.className = 'text-xs ' + (r.ok === false || r.ok === undefined && r.error ? 'text-red-600' : 'text-gray-600');
        const parts = [];
        if (r.url) parts.push(r.url);
        if (r.step) parts.push(`步骤${r.step} ${r.name || ''}`);
        if (r.status_code) parts.push(`状态 ${r.status_code}`);
        if (typeof r.latency_ms === 'number') parts.push(`${r.latency_ms}ms`);
        if (r.error) parts.push('错误: ' + r.error);
        line.textContent = (r.ok === false ? '✗ ' : '✓ ') + parts.filter(Boolean).join(' · ');
        box.appendChild(line);
      });
      detail.appendChild(box);
    }
    if (job.status === 'passed' || job.status === 'failed') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'apple-button px-3 py-1.5 text-xs mt-1';
      retry.textContent = '↻ 用相同参数重试';
      retry.title = '以本任务的原参数创建一个新任务';
      retry.addEventListener('click', (ev) => {
        ev.stopPropagation(); // 不触发展开/收起
        window.dispatchEvent(new CustomEvent('job:retry', { detail: job }));
      });
      detail.appendChild(retry);
    }

    // 操作按钮行
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap gap-2 mt-2';

    const mkBtn = (text, cls, title, event) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        window.dispatchEvent(new CustomEvent(event, { detail: job }));
      });
      actions.appendChild(b);
    };

    if (job.status === 'pending' || job.status === 'running') {
      mkBtn('取消任务', 'px-3 py-1.5 text-xs rounded-lg border border-orange-200 text-orange-700 bg-orange-50 hover:bg-orange-100 transition-colors', '标记为已取消，不再派发执行', 'job:cancel');
    }
    mkBtn('删除任务', 'px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-700 bg-red-50 hover:bg-red-100 transition-colors', '从列表移除该任务', 'job:delete');
    mkBtn('查看执行记录', 'px-3 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-700 bg-white hover:bg-gray-100 transition-colors', '加载 Agent 上传的 steps / 日志', 'job:artifacts');
    detail.appendChild(actions);

    // 产物内容挂载点
    const artifactBox = document.createElement('div');
    artifactBox.className = 'mt-2 space-y-2';
    artifactBox.setAttribute('data-artifact-target', String(job.job_id));
    detail.appendChild(artifactBox);

    return detail;
  }
  renderSkillsListWithVirtualScroll(skills, container) {
    if (!skills || skills.length === 0) {
      const emptyElement = document.createElement('div');
      emptyElement.className = 'text-gray-500 text-sm';
      emptyElement.textContent = '暂无技能';
      container.innerHTML = '';
      container.appendChild(emptyElement);
      return;
    }

    // 使用虚拟滚动
    this.initVirtualScroll(
      container,
      skills,
      (skill) => {
        const skillItem = document.createElement('div');
        skillItem.className = 'flex items-center py-1';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `skill-${skill.id}`;
        checkbox.dataset.skillId = skill.id;
        checkbox.className = 'skill-checkbox mr-3 text-blue-500 focus:ring-blue-200 border-gray-200 rounded';

        const label = document.createElement('label');
        label.htmlFor = `skill-${skill.id}`;
        label.className = 'text-sm text-gray-700 cursor-pointer';
        label.textContent = skill.name;

        skillItem.appendChild(checkbox);
        skillItem.appendChild(label);

        return skillItem;
      },
      30 // 每个技能项的高度（像素）
    );
  }

  /**
   * 节流函数
   * @param {Function} fn - 要节流的函数
   * @param {number} delay - 延迟时间（毫秒）
   * @returns {Function} - 节流后的函数
   */
  throttle(fn, delay) {
    let lastCall = 0;
    return function(...args) {
      const now = Date.now();
      if (now - lastCall >= delay) {
        lastCall = now;
        return fn.apply(this, args);
      }
    };
  }

  /**
   * 防抖函数
   * @param {Function} fn - 要防抖的函数
   * @param {number} delay - 延迟时间（毫秒）
   * @returns {Function} - 防抖后的函数
   */
  debounce(fn, delay) {
    let timeoutId;
    return function(...args) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn.apply(this, args), delay);
    };
  }
}

// 导出单例实例
const renderService = new RenderService();
export default renderService;
