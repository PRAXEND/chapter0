const sections = [
  {
    id: "prep", title: "会前准备", goal: "让正确的人带着正确的材料进入会议，提前暴露必须回答的问题。",
    source: "会议强调需求确认要快速进入执行，并尽量减少第一版之后的反复修改。",
    questions: ["本次会议的目标是探索机会、需求澄清、技术评估、PoC 设计、报价确认还是项目启动？", "业务负责人、实际用户或流程负责人、技术负责人是否参会？", "现有流程图、接口文档、样例数据、系统清单、安全要求和历史方案是否已收集？", "录音、数据样例和系统截图的使用范围是否明确？", "已知事实、团队假设和待客户确认的问题是否分开记录？", "会议记录人、时间控制人和会后确认稿负责人是否明确？", "AI 项目是否已请求代表性的真实样例与期望输出？"],
    evidence: ["会议议程", "参会角色清单", "客户资料包", "必须回答的问题清单"],
    done: "会议议程、参会角色、资料清单和必须回答的问题已发给所有相关人员。"
  },
  {
    id: "context", title: "客户与项目背景", goal: "确认谁提出需求、谁使用结果、谁承担预算、谁做最终决定。",
    source: "会议提出先介绍客户基本背景和要解决的问题。",
    questions: ["客户的业务类型、组织规模、所在区域和涉及的业务单元是什么？", "业务发起人、项目负责人、技术负责人、安全/合规负责人、预算负责人和最终签字人分别是谁？", "为什么现在启动项目？是否有合同、监管、旺季、融资或发布节点？", "此前是否做过类似项目？哪些方案有效或失败，原因是什么？", "客户如何理解 FDE 的角色：咨询、原型、开发、部署、运营还是全流程交付？", "哪些内部团队会受影响，是否存在推动阻力？", "预算范围和决策流程是什么？"],
    evidence: ["关键干系人名单", "现有项目资料与历史方案", "目标日期与预算范围", "决策与签字流程"],
    done: "业务负责人、技术负责人和最终决策人均已确认，项目动机、时间窗口和决策流程无关键空白。"
  },
  {
    id: "business", title: "业务问题与成功标准", goal: "把愿望转成可衡量的业务结果，不以功能数量替代项目价值。",
    source: "会议要求明确客户预期和要解决的核心问题。",
    questions: ["现在发生了什么问题？能否用最近一次真实案例说明？", "当前流程消耗多少时间、人力或成本？错误、延迟、漏单或风险基线是多少？", "问题影响哪些人、客户、收入、成本或风险指标？", "如果六个月内不解决，会发生什么？", "成功后哪些指标应改变？目标值、观察周期和数据来源是什么？", "速度、准确率、成本、可控性、合规和体验冲突时如何取舍？", "谁有权确认业务结果已达到？"],
    evidence: ["当前流程数据或基线报表", "典型案例与反例", "业务指标定义与目标值", "结果确认人"],
    done: "每个核心需求都能追溯到一个业务目标，并有基线、目标值、测量方法和确认人。"
  },
  {
    id: "workflow", title: "用户角色与现有流程", goal: "理解真实主流程、异常流程和人工判断，避免只按管理层描述设计。",
    questions: ["谁每天使用、偶尔使用、只查看结果，谁负责审批或纠错？", "能否从触发事件开始演示当前流程直到结果关闭？", "每一步由谁完成，使用什么系统或文件，输入来自哪里，输出交给谁？", "常见异常、退回、补录、重复处理和人工判断在哪里发生？", "高峰期、夜间、跨区域或多人并发时流程是否不同？", "用户需要哪些权限、语言、设备和无障碍支持？", "新方案是替代、辅助还是监督现有人员？哪些步骤必须人工确认？"],
    evidence: ["端到端流程演示或录屏", "角色与权限矩阵", "异常案例与人工规则", "流程交接点清单"],
    done: "主流程、异常流程和各角色责任已记录，每个交接点都有明确输入、输出和负责人。"
  },
  {
    id: "scope", title: "范围与优先级", goal: "确定第一阶段的最小闭环，并明确暂不承诺的事项。",
    source: "会议强调需求要足够细、流程要完整并形成闭环，以减少后续大改。",
    questions: ["第一阶段必须解决的最小闭环是什么？", "哪些功能是必须做、应该做、可延后和明确不做？", "适用于哪些地区、组织、用户、产品线和数据范围？", "哪些现有流程或系统不会被替换？", "PoC、试点和生产版本的边界分别是什么？", "时间或预算不足时如何裁剪？谁决定？", "新增需求如何评估对成本、周期、架构和验收的影响？"],
    evidence: ["按优先级排列的需求列表", "范围内/范围外清单", "PoC、试点与生产边界", "变更批准人"],
    done: "第一阶段范围可用一句话描述；范围外事项、优先级和变更批准人均已确认。"
  },
  {
    id: "data", title: "数据与输入", goal: "确认数据真实可得、可用并可合法处理；没有样例时效果和工期只能是初步判断。",
    source: "会议明确提出需要讲清输入。",
    questions: ["每项输入来自哪个系统、文件、设备或人工操作？", "能否提供代表性样例、字段说明、取值范围和异常样例？", "数据量、单条大小、历史跨度、更新频率、峰值和增长速度是多少？", "完整性、准确性、去重和及时性如何？冲突时以哪个系统为准？", "谁拥有数据，谁批准访问，使用目的和保存期限是什么？", "是否包含个人信息、商业秘密、监管数据或跨境限制？", "生产数据不能用于开发时，是否有脱敏、合成数据或安全沙箱？", "输入变化或数据源中断时如何检测、告警和降级？"],
    evidence: ["真实或脱敏样例数据", "字段字典、接口文档与数据血缘", "数据授权、分类与留存要求", "质量统计与异常样例"],
    done: "核心数据源有样例、负责人、访问路径和质量结论，敏感数据处理依据已确认。"
  },
  {
    id: "output", title: "输出与使用方式", goal: "明确最终交付给客户什么，以及结果如何进入日常工作。",
    source: "会议明确提到网页、API 等交付形态以及日后的使用方式。",
    questions: ["结果以网页、API、文件、报告、消息通知、系统回写还是其他方式提供？", "每种输出由谁在什么时间、设备和场景使用？", "输出必须包含哪些字段、解释、证据、置信度、状态或审计信息？", "是否需要下载、批量导出、搜索、筛选、审批、编辑或重新处理？", "API 调用方、协议、鉴权、版本、错误码、限流和幂等要求是什么？", "结果写回哪些系统？失败、重复或部分成功时怎么处理？", "是否需要多语言、多租户、白标、移动端或离线使用？", "输出错误时如何纠正，纠正结果是否用于后续规则或模型改进？"],
    evidence: ["期望输出样例或线框图", "接口契约与回写要求", "用户从收到结果到完成工作的流程", "权限与错误处理规则"],
    done: "每种输出都有格式、使用者、场景、权限、错误处理和成功确认方式。"
  },
  {
    id: "functions", title: "功能与业务规则", goal: "把业务目标拆成可开发、可测试的系统行为，并覆盖权限与边界条件。",
    questions: ["什么条件触发功能，系统执行什么，完成后产生什么结果？", "关键业务规则、计算公式、阈值、审批条件和例外是什么？", "用户能否新增、修改、撤销、重试、批量处理或回滚？", "不同角色看到的内容和可执行动作有何不同？", "重复请求、缺失输入、无权限、超时和外部系统故障如何响应？", "哪些状态需要通知，通知给谁、通过什么渠道，是否需要升级提醒？", "哪些操作必须保留原因、日志和操作前后数据？"],
    evidence: ["用户故事或场景说明", "业务规则与异常处理表", "角色权限说明", "高优先级功能验收场景"],
    done: "每个高优先级功能都有触发条件、正常结果、异常结果、权限和可验证场景。"
  },
  {
    id: "ai", title: "AI 项目专项", goal: "为模型、Agent、RAG 或自动决策建立可重复评测和人工兜底。",
    questions: ["AI 执行分类、抽取、生成、检索、预测、推荐、规划还是自动操作？", "哪些结果允许概率性，哪些必须确定、可解释或可追溯？", "误报、漏报、事实错误和不当内容的成本分别是什么？", "谁提供参考答案？评测集是否覆盖正常、边界、对抗和低质量输入？", "用哪些指标和阈值验收：准确率、召回率、任务成功率、人工通过率或单任务成本？", "何时必须人工复核？敏感动作或高风险结果如何阻止自动执行？", "允许哪些模型、区域和供应商？客户数据能否由外部服务处理？", "知识更新频率、权威来源、引用要求和过期内容如何处理？", "模型或工具不可用时如何降级、回退或切换到人工？", "上线后如何监控漂移、复盘错误并批准模型或提示词变更？"],
    evidence: ["代表性评测集与参考答案", "错误分类、风险分级与人工复核规则", "模型、知识库和工具调用限制", "AI 效果与成本基线"],
    done: "评测集、指标、阈值、人工兜底和供应商限制已批准；高风险动作不会无授权自动执行。"
  },
  {
    id: "tech", title: "技术环境与系统集成", goal: "确认运行环境、接入方式和开通依赖的责任人。",
    source: "会议提到网页、API 及安装到客户电脑等不同交付方式。",
    questions: ["部署在客户电脑、客户机房、客户云、供应商云还是混合环境？", "是否区分开发、测试、预发布和生产环境？谁提供和维护？", "需要集成哪些系统、数据库、目录、消息队列、存储或第三方 API？", "是否已有 API 文档、测试环境、服务账号和技术联系人？", "是否存在代理、专线、VPN、内外网隔离、白名单或无公网环境？", "身份认证采用单点登录、OAuth、企业目录还是本地账号？", "对操作系统、浏览器、数据库、容器、云厂商和开源组件有何限制？", "谁负责域名、证书、密钥轮换、部署审批和上线窗口？", "环境、接口或权限延迟如何影响排期？"],
    evidence: ["现状架构图与目标部署图", "接口文档、测试账号与网络清单", "环境与依赖责任矩阵", "关键依赖日期"],
    done: "部署方式、集成点、网络路径、身份方式和环境责任已确认，关键依赖有负责人和日期。"
  },
  {
    id: "security", title: "安全、隐私与合规", goal: "在定方案前识别数据、身份和运营风险，避免上线前返工。",
    questions: ["涉及哪些数据分类和监管要求？是否有个人、医疗、金融、未成年人或跨境数据？", "最小权限如何实现？账号由谁创建、审批、撤销和复核？", "传输和存储如何加密？密钥由谁管理？", "日志记录什么、谁能查看、保存多久，是否包含敏感信息？", "数据、提示词、模型输入输出和备份保存在哪里、多久、如何删除？", "第三方模型、云服务、开源组件和外包人员是否需要安全评审？", "是否需要漏洞扫描、渗透测试、代码审计、等保或其他认证？", "安全事件由谁发现、通知、处置和对外沟通？时限是什么？", "合同终止后如何导出、移交和删除数据与凭据？"],
    evidence: ["安全政策与数据分类规则", "访问控制、加密、日志和留存要求", "安全评审记录", "事件响应流程"],
    done: "安全负责人已确认数据处理路径、访问控制、留存删除和第三方限制。"
  },
  {
    id: "nfr", title: "非功能要求", goal: "把性能、可靠性、兼容性和运营要求变成可测量目标。",
    questions: ["典型与峰值请求量、并发用户、数据量和增长率是多少？", "关键操作响应时间和批处理完成时间是多少？", "可用性目标和允许维护窗口是什么？", "故障时允许丢失多少数据、允许中断多久？", "是否需要水平扩展、区域冗余、离线运行或边缘部署？", "支持哪些设备、浏览器、操作系统、语言和时区？", "监控哪些业务与技术指标？谁接收告警、谁处理？", "是否有单次任务、月度用量或云资源成本上限？"],
    evidence: ["容量与性能基线", "可用性、恢复与备份要求", "兼容性清单", "用量与成本上限"],
    done: "关键非功能要求都有数值、测量条件和责任人，而非只写“高性能”或“高可用”。"
  },
  {
    id: "acceptance", title: "交付物与验收", goal: "提前明确最终交付物、验收方法、签字人和通过条件。",
    source: "会议明确提出要定义交付标准，并由客户测试确认。",
    questions: ["最终交付系统、网页、API、安装包、源代码、配置、模型、脚本、文档、培训还是运营支持？", "每个交付物的格式、版本、运行环境、渠道和所有权是什么？", "客户使用什么数据、场景、环境和步骤验收？", "每项指标的阈值、容差和测量工具是什么？", "验收由谁组织、执行和签字，计划何时完成？", "缺陷如何分级？哪些阻止验收，哪些进入后续版本？", "客户未按时提供数据、环境、接口或反馈时，日期如何调整？", "试运行、保修或稳定期多长？完成标准是什么？", "培训对象、次数、材料和交接范围是什么？"],
    evidence: ["交付物清单与版本说明", "验收用例、数据与指标阈值", "缺陷分级", "验收签字人与日期"],
    done: "每个交付物都能由指定人员在指定环境按指定方法验收，并有明确通过条件。"
  },
  {
    id: "plan", title: "实施计划与双方责任", goal: "把实施步骤、客户依赖和决策节奏写进计划，而非只给总工期。",
    source: "会议要求提前讲清实施步骤。",
    questions: ["项目分为调研、PoC、试点、开发、集成、测试、上线和稳定期中的哪些阶段？", "每阶段的入口条件、输出、负责人和退出标准是什么？", "客户需提供哪些人员、数据、环境、账号、接口、审批和反馈？截止何时？", "固定会议、进度汇报、演示和评审频率是什么？", "谁做日常决策，哪些事项需要升级到双方管理层？", "客户反馈和确认时限是多少？逾期如何影响计划？", "是否需要现场工作、差旅、特定办公时间或客户设备？", "团队成员变动或关键人员不可用时如何交接？"],
    evidence: ["里程碑计划", "责任分工矩阵", "客户依赖清单", "决策与升级机制"],
    done: "每个里程碑有可交付结果；客户依赖、确认时限和延期处理已写入计划。"
  },
  {
    id: "commercial", title: "成本、报价与商务边界", goal: "公开报价依据、不确定性、包含项和变化触发条件。",
    source: "会议提出成本相当于报价，需要在需求确认阶段提前沟通。",
    questions: ["采用固定价、时间材料、订阅、按量还是分阶段报价？", "估算基于哪些范围、数据质量、集成条件、人员投入和客户配合假设？", "包含和不包含哪些内容：云资源、模型调用、第三方软件、硬件、差旅、税费和长期运维？", "是否有最低用量、并发、数据量或支持时段限制？", "付款节点如何与里程碑和验收关联？", "需求变更、客户延期或第三方接口变化如何重新估算？", "代码、模型、配置、数据、文档和通用组件的知识产权如何划分？", "合同终止、暂停或扩大范围时如何结算和移交？"],
    evidence: ["估算说明与关键假设", "包含项与不包含项", "第三方费用与用量模型", "付款、变更与知识产权条款"],
    done: "客户能解释报价覆盖什么、不覆盖什么，以及哪些变化会改变价格或交付日期。"
  },
  {
    id: "operations", title: "上线运维与迭代", goal: "确保交付后有人维护、处理故障并决定迭代。",
    source: "会议要求前期就讨论日后的使用方式和后续迭代。",
    questions: ["上线后谁负责业务运营、技术运维、账号管理、数据质量和安全事件？", "支持时段、响应时间、问题渠道和升级流程是什么？", "监控哪些业务和技术指标？谁看仪表盘和接收告警？", "如何备份、恢复、回滚和发布新版本？", "外部模型、接口或依赖升级时如何验证兼容性？", "用户如何提交反馈、错误样例和新需求？谁排序和批准？", "迭代按固定周期、工作量包还是单独报价？", "何时效果复盘，哪些指标决定继续、扩展、调整或停止？"],
    evidence: ["运行责任与支持约定", "监控、备份、恢复与发布流程", "反馈与需求池", "迭代评审机制"],
    done: "上线后责任、支持、监控、恢复和迭代机制明确，并有对应人员接受交接。"
  },
  {
    id: "risks", title: "风险、假设与未决问题", goal: "把未知项变成可追踪任务，避免在报价和排期中隐藏风险。",
    questions: ["哪些事实尚未验证？哪些只是客户或团队假设？", "哪些依赖由客户、第三方或监管机构控制？", "数据、模型、接口、环境、人员或审批中，哪个最可能影响交付？", "每个风险的发生可能性、影响和应对措施是什么？", "哪些关键假设需要通过 PoC、技术调研或安全评审验证？", "哪些问题在报价前必须关闭，哪些可在项目中继续确认？"],
    evidence: ["风险登记册", "假设清单与验证计划", "未决问题负责人", "截止时间与处理方式"],
    done: "所有影响范围、成本、周期、安全或验收的未知项都有负责人、截止时间和处理方式。"
  }
];

const scoreAreas = [
  ["业务目标", "问题、价值和成功指标"], ["范围", "范围内、范围外和优先级"], ["数据", "样例、权限、质量和规模"],
  ["输出", "形式、使用流程和下游系统"], ["技术", "部署、集成、网络和身份"], ["安全", "数据处理、访问、留存和审批"],
  ["验收", "场景、阈值、数据和签字人"], ["计划", "里程碑、客户依赖和反馈时限"], ["成本", "估算假设、包含项和第三方费用"],
  ["运维", "支持、监控、恢复和迭代责任"]
];

const gates = ["业务负责人和技术负责人已指定", "第一阶段范围与范围外事项已确认", "关键输入数据有样例或明确提供日期", "部署与数据处理路径经技术和安全负责人确认", "验收场景、阈值和签字人已确定", "客户依赖、反馈时限与延期影响已写入计划", "报价假设、包含项和不包含项已写清", "新增需求有正式变更与重新估算机制"];

const summaryFields = [
  ["coreProblem", "核心问题"], ["phaseOne", "第一阶段范围"], ["outOfScope", "明确不包含"], ["inputs", "主要输入"],
  ["outputs", "主要输出"], ["delivery", "交付方式与使用方式"], ["acceptance", "验收方法与签字人"], ["clientDependency", "客户依赖与提供日期"],
  ["largestOpen", "最大未决问题"], ["confirmedConclusions", "已确认结论"], ["nextStep", "下一步"]
];

const STORAGE_KEY = "fde-discovery-workbench-v1";
let state = loadState();
let activeView = "overview";
let saveTimer;

function defaultState() {
  return {
    meta: { clientName: "", projectName: "", meetingDate: new Date().toISOString().slice(0,10) },
    sections: Object.fromEntries(sections.map(s => [s.id, { status: "unknown", checks: {}, evidence: {}, notes: "" }])),
    summary: Object.fromEntries(summaryFields.map(([id]) => [id, ""])),
    scores: Object.fromEntries(scoreAreas.map(([name]) => [name, 0])),
    gates: {}, actions: [{item:"", owner:"", due:"", evidence:""}],
    changes: [{id:"CR 001", content:"", impact:"", approver:"", decision:""}]
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const base = defaultState();
    return saved ? {...base, ...saved, meta:{...base.meta,...saved.meta}, sections:{...base.sections,...saved.sections}, summary:{...base.summary,...saved.summary}, scores:{...base.scores,...saved.scores}} : base;
  } catch { return defaultState(); }
}

function saveState() {
  clearTimeout(saveTimer);
  document.getElementById("saveState").textContent = "保存中…";
  saveTimer = setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    document.getElementById("saveState").textContent = "已自动保存";
    updateProgress();
  }, 160);
}

function navMarkup() {
  const sectionItems = sections.map((s, i) => `<button class="nav-item" data-view="${s.id}"><span class="nav-index">${String(i+1).padStart(2,"0")}</span><span>${s.title}</span><i class="nav-status ${state.sections[s.id]?.status || "unknown"}" data-nav-status="${s.id}"></i></button>`).join("");
  return `<div class="nav-group-label">工作区</div>
    <button class="nav-item active" data-view="overview"><span class="nav-index">⌂</span><span>总览</span></button>
    <div class="nav-group-label">需求清单</div>${sectionItems}
    <div class="nav-group-label">收尾与决策</div>
    <button class="nav-item" data-view="summary"><span class="nav-index">✓</span><span>会议结论与行动项</span></button>
    <button class="nav-item" data-view="readiness"><span class="nav-index">20</span><span>报价准入评估</span></button>`;
}

function renderNav() {
  const nav = document.getElementById("navList");
  nav.innerHTML = navMarkup();
  nav.querySelectorAll("[data-view]").forEach(btn => btn.addEventListener("click", () => showView(btn.dataset.view)));
}

function showView(view) {
  activeView = view;
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.getElementById("sidebar").classList.remove("open");
  if (view === "overview") renderOverview();
  else if (view === "summary") renderSummary();
  else if (view === "readiness") renderReadiness();
  else renderSection(sections.find(s => s.id === view));
  window.scrollTo({top: 0, behavior: "smooth"});
}

function statusLabel(status) { return ({unknown:"未确认", partial:"部分确认", confirmed:"已确认", na:"不适用"})[status] || "未确认"; }

function renderOverview() {
  const cards = sections.map((s, i) => {
    const sectionState = state.sections[s.id] || {};
    const status = sectionState.status || "unknown";
    return `<article class="overview-card"><button data-open="${s.id}"><span class="overview-num">${String(i+1).padStart(2,"0")}</span><h3>${s.title}</h3><p>${s.goal}</p><div class="overview-footer"><span class="status-pill ${status}">${statusLabel(status)}</span><span aria-hidden="true">→</span></div></button></article>`;
  }).join("");
  document.getElementById("workspace").innerHTML = `<section class="panel"><div class="panel-header"><span class="panel-kicker">全局视图</span><h2>需求确认总览</h2><p>从业务价值到上线运营逐项完成。影响方案、报价或交付日期的未知项，必须进入风险与未决问题清单。</p></div><div class="panel-body"><div class="overview-grid">${cards}</div></div></section>`;
  document.querySelectorAll("[data-open]").forEach(btn => btn.addEventListener("click", () => showView(btn.dataset.open)));
}

function renderSection(section) {
  const ss = state.sections[section.id] || {status:"unknown",checks:{},evidence:{},notes:""};
  const questions = section.questions.map((q, i) => `<label class="check-row"><input type="checkbox" data-question="${i}" ${ss.checks?.[i] ? "checked" : ""}><span class="fake-check"></span><span>${q}</span></label>`).join("");
  const evidence = section.evidence.map((e, i) => `<label class="check-row"><input type="checkbox" data-evidence="${i}" ${ss.evidence?.[i] ? "checked" : ""}><span class="fake-check"></span><span>${e}</span></label>`).join("");
  const statuses = ["unknown","partial","confirmed","na"].map(st => `<button class="status-button ${ss.status===st?"active":""}" data-status="${st}">${statusLabel(st)}</button>`).join("");
  document.getElementById("workspace").innerHTML = `<section class="panel"><div class="panel-header"><div class="section-toolbar"><div><span class="panel-kicker">需求模块 ${String(sections.indexOf(section)+1).padStart(2,"0")}</span><h2>${section.title}</h2><p>${section.goal}</p></div><div class="status-control" aria-label="模块状态">${statuses}</div></div></div><div class="panel-body"><div class="section-grid"><div><h3 class="subheading">必问问题</h3><div class="question-list">${questions}</div></div><aside class="side-stack">${section.source ? `<div class="callout source-callout"><strong>来自会议的要求</strong><p>${section.source}</p></div>`:""}<div><h3 class="subheading">需收集的证据</h3><div class="evidence-list">${evidence}</div></div><div class="callout"><strong>完成标准</strong><p>${section.done}</p></div><div><label class="field-label" for="sectionNotes">会议记录</label><textarea id="sectionNotes" placeholder="记录客户原话、事实证据、假设、负责人和截止时间…">${escapeHtml(ss.notes || "")}</textarea></div></aside></div></div></section>`;
  document.querySelectorAll("[data-status]").forEach(btn => btn.addEventListener("click", () => { state.sections[section.id].status = btn.dataset.status; saveState(); renderSection(section); renderNav(); setActiveNav(); }));
  document.querySelectorAll("[data-question]").forEach(cb => cb.addEventListener("change", () => { state.sections[section.id].checks[cb.dataset.question] = cb.checked; saveState(); }));
  document.querySelectorAll("[data-evidence]").forEach(cb => cb.addEventListener("change", () => { state.sections[section.id].evidence[cb.dataset.evidence] = cb.checked; saveState(); }));
  document.getElementById("sectionNotes").addEventListener("input", e => { state.sections[section.id].notes = e.target.value; saveState(); });
}

function renderSummary() {
  const fields = summaryFields.map(([id,label]) => `<div class="form-field ${["confirmedConclusions","nextStep"].includes(id)?"full":""}"><label for="${id}">${label}</label><textarea id="${id}" data-summary="${id}" placeholder="填写${label}…">${escapeHtml(state.summary[id]||"")}</textarea></div>`).join("");
  document.getElementById("workspace").innerHTML = `<section class="panel"><div class="panel-header"><span class="panel-kicker">会议结束前复述</span><h2>会议结论与行动项</h2><p>把口头讨论转为双方可确认的基线。新增、删除或改变验收条件的请求，应先记录影响并获得批准。</p></div><div class="panel-body"><div class="form-grid">${fields}</div></div></section>
  <section class="panel"><div class="panel-header"><h2>行动项</h2><p>所有未决问题都需要负责人、截止时间与完成证据。</p></div><div class="panel-body"><div class="toolbar-row"><button class="button ghost row-add" id="addAction">＋ 添加行动项</button></div>${renderActions()}</div></section>
  <section class="panel"><div class="panel-header"><h2>变更记录</h2><p>变更只有在评估范围、成本、周期、架构、安全和已完成工作的影响并获批后，才进入执行计划。</p></div><div class="panel-body"><div class="toolbar-row"><button class="button ghost row-add" id="addChange">＋ 添加变更</button></div>${renderChanges()}</div></section>`;
  document.querySelectorAll("[data-summary]").forEach(el => el.addEventListener("input", e => { state.summary[e.target.dataset.summary]=e.target.value; saveState(); }));
  bindTableInputs();
  document.getElementById("addAction").addEventListener("click", () => { state.actions.push({item:"",owner:"",due:"",evidence:""}); saveState(); renderSummary(); });
  document.getElementById("addChange").addEventListener("click", () => { state.changes.push({id:`CR ${String(state.changes.length+1).padStart(3,"0")}`,content:"",impact:"",approver:"",decision:""}); saveState(); renderSummary(); });
}

function renderActions() {
  const rows = state.actions.map((r,i)=>`<tr><td><textarea data-table="actions" data-row="${i}" data-key="item">${escapeHtml(r.item)}</textarea></td><td><input data-table="actions" data-row="${i}" data-key="owner" value="${escapeAttr(r.owner)}"></td><td><input type="date" data-table="actions" data-row="${i}" data-key="due" value="${escapeAttr(r.due)}"></td><td><textarea data-table="actions" data-row="${i}" data-key="evidence">${escapeHtml(r.evidence)}</textarea></td><td><button class="button ghost danger" data-remove-action="${i}">删除</button></td></tr>`).join("");
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>行动项</th><th>负责人</th><th>截止时间</th><th>完成证据</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderChanges() {
  const rows = state.changes.map((r,i)=>`<tr><td><input data-table="changes" data-row="${i}" data-key="id" value="${escapeAttr(r.id)}"></td><td><textarea data-table="changes" data-row="${i}" data-key="content">${escapeHtml(r.content)}</textarea></td><td><textarea data-table="changes" data-row="${i}" data-key="impact">${escapeHtml(r.impact)}</textarea></td><td><input data-table="changes" data-row="${i}" data-key="approver" value="${escapeAttr(r.approver)}"></td><td><textarea data-table="changes" data-row="${i}" data-key="decision">${escapeHtml(r.decision)}</textarea></td><td><button class="button ghost danger" data-remove-change="${i}">删除</button></td></tr>`).join("");
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>编号</th><th>变更内容</th><th>影响评估</th><th>批准人</th><th>决定和日期</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function bindTableInputs() {
  document.querySelectorAll("[data-table]").forEach(el => el.addEventListener("input", e => { const {table,row,key}=e.target.dataset; state[table][Number(row)][key]=e.target.value; saveState(); }));
  document.querySelectorAll("[data-remove-action]").forEach(btn => btn.addEventListener("click", () => { state.actions.splice(Number(btn.dataset.removeAction),1); if(!state.actions.length) state.actions.push({item:"",owner:"",due:"",evidence:""}); saveState(); renderSummary(); }));
  document.querySelectorAll("[data-remove-change]").forEach(btn => btn.addEventListener("click", () => { state.changes.splice(Number(btn.dataset.removeChange),1); if(!state.changes.length) state.changes.push({id:"CR 001",content:"",impact:"",approver:"",decision:""}); saveState(); renderSummary(); }));
}

function renderReadiness() {
  const scores = scoreAreas.map(([name,desc]) => `<div class="score-row"><strong>${name}</strong><span>${desc}</span><div class="score-options">${[0,1,2].map(n=>`<button class="${Number(state.scores[name])===n?"active":""}" data-score-area="${name}" data-score="${n}">${n} · ${["未知","部分","确认"][n]}</button>`).join("")}</div></div>`).join("");
  const gateList = gates.map((g,i)=>`<label class="check-row"><input type="checkbox" data-gate="${i}" ${state.gates[i]?"checked":""}><span class="fake-check"></span><span>${g}</span></label>`).join("");
  const total = Object.values(state.scores).reduce((a,b)=>a+Number(b||0),0);
  const decision = readinessDecision(total);
  document.getElementById("workspace").innerHTML = `<section class="panel"><div class="panel-header"><span class="panel-kicker">内部管理判断</span><h2>报价和签约前准入评估</h2><p>判断是否可以给出固定范围、固定报价和固定日期；不替代合同与专业合规审查。</p></div><div class="panel-body"><div class="score-grid">${scores}</div><div class="score-result"><div class="score-number">${total}<small>/20</small></div><div><h3>${decision.title}</h3><p>${decision.text}</p></div></div><h3 class="subheading" style="margin-top:24px">必须通过的门槛</h3><div class="gate-list">${gateList}</div></div></section>`;
  document.querySelectorAll("[data-score-area]").forEach(btn=>btn.addEventListener("click",()=>{state.scores[btn.dataset.scoreArea]=Number(btn.dataset.score);saveState();renderReadiness();}));
  document.querySelectorAll("[data-gate]").forEach(cb=>cb.addEventListener("change",()=>{state.gates[cb.dataset.gate]=cb.checked;saveState();}));
}

function readinessDecision(total) {
  const blocked = ["安全","数据","验收"].some(k => Number(state.scores[k]) === 0);
  if (blocked) return {title:"存在关键门槛",text:"合法性、安全审批、数据访问或验收责任仍不明确，应先关闭关键问题，再承诺固定报价和日期。"};
  if (total >= 16) return {title:"可进入固定范围方案或报价",text:"关键前提已经较完整。仍需把假设、包含项、不包含项与变更机制写入正式文件。"};
  if (total >= 11) return {title:"建议先做付费调研或 PoC",text:"信息足以继续推进，但仍有重要不确定性，不宜直接锁定最终效果或完整交付日期。"};
  return {title:"暂不建议固定承诺",text:"需求、数据或责任边界仍有较大空白。优先完成发现阶段，再进行正式估算。"};
}

function updateProgress() {
  const statusWeight = {unknown:0, partial:.5, confirmed:1, na:1};
  const score = sections.reduce((sum,s)=>sum+(statusWeight[state.sections[s.id]?.status]||0),0);
  const percent = Math.round(score/sections.length*100);
  const confirmed = sections.filter(s=>["confirmed","na"].includes(state.sections[s.id]?.status)).length;
  const checked = sections.reduce((sum,s)=>sum+Object.values(state.sections[s.id]?.checks||{}).filter(Boolean).length,0);
  document.getElementById("progressPercent").textContent = `${percent}%`;
  document.getElementById("progressBar").style.width = `${percent}%`;
  document.getElementById("progressText").textContent = percent===100 ? "全部模块已完成" : percent ? `${confirmed} 个模块已完成` : "尚未开始";
  document.getElementById("confirmedCount").textContent = confirmed;
  document.getElementById("openCount").textContent = sections.length-confirmed;
  document.getElementById("questionCount").textContent = checked;
  document.querySelectorAll("[data-nav-status]").forEach(dot=>dot.className=`nav-status ${state.sections[dot.dataset.navStatus]?.status||"unknown"}`);
}

function setActiveNav(){ document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.view===activeView)); }

function exportRecord() {
  const lines = [`# FDE 客户需求沟通记录`, ``, `- 客户：${state.meta.clientName||"未填写"}`, `- 项目：${state.meta.projectName||"未填写"}`, `- 会议日期：${state.meta.meetingDate||"未填写"}`, ``];
  sections.forEach(s=>{
    const ss=state.sections[s.id];
    lines.push(`## ${s.title}`, `状态：${statusLabel(ss.status)}`, ``, `### 已核对问题`);
    const checked=s.questions.filter((_,i)=>ss.checks?.[i]);
    lines.push(...(checked.length?checked.map(q=>`- ${q}`):["- 暂无"]));
    lines.push(``, `### 已取得证据`);
    const evidence=s.evidence.filter((_,i)=>ss.evidence?.[i]);
    lines.push(...(evidence.length?evidence.map(e=>`- ${e}`):["- 暂无"]));
    lines.push(``, `### 会议记录`, ss.notes||"暂无", ``);
  });
  lines.push(`# 会议结论`, ``);
  summaryFields.forEach(([id,label])=>lines.push(`- ${label}：${state.summary[id]||"未填写"}`));
  lines.push(``, `# 行动项`, ``);
  state.actions.forEach((a,i)=>lines.push(`${i+1}. ${a.item||"未填写"}｜负责人：${a.owner||"未填写"}｜截止：${a.due||"未填写"}｜证据：${a.evidence||"未填写"}`));
  const total=Object.values(state.scores).reduce((a,b)=>a+Number(b||0),0);
  lines.push(``, `# 报价准入评估`, ``, `总分：${total}/20`, `结论：${readinessDecision(total).title}`, ``);
  download(`FDE需求沟通记录-${safeName(state.meta.clientName||"客户")}.md`, lines.join("\n"), "text/markdown;charset=utf-8");
  toast("记录已导出");
}

function download(name, content, type) {
  const blob=new Blob([content],{type}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),500);
}
function safeName(s){ return String(s).replace(/[\\/:*?"<>|]/g,"-").slice(0,40); }
function escapeHtml(s){ return String(s??"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function escapeAttr(s){ return escapeHtml(s).replace(/"/g,"&quot;"); }
function toast(message){ const el=document.getElementById("toast");el.textContent=message;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),1800); }

function init() {
  renderNav(); renderOverview(); updateProgress();
  ["clientName","projectName","meetingDate"].forEach(id=>{ const el=document.getElementById(id);el.value=state.meta[id]||"";el.addEventListener("input",e=>{state.meta[id]=e.target.value;saveState();}); });
  document.getElementById("menuButton").addEventListener("click",()=>document.getElementById("sidebar").classList.toggle("open"));
  document.getElementById("printButton").addEventListener("click",()=>window.print());
  document.getElementById("exportButton").addEventListener("click",exportRecord);
}

init();
