const STORAGE_KEY = "bluebanana-market-v3";
const BASE_PRICE = 5;
const STARTING_BALANCE = 1000;
const SHORT_MARGIN_RATE = 0.5;

const teamNames = Array.from({ length: 29 }, (_, index) => `Grupo ${index + 1}`);

const byId = (id) => document.getElementById(id);
const fmt = (number, digits = 2) => Number(number).toLocaleString("es-CL", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const intFmt = (number) => Math.round(number).toLocaleString("es-CL");

const elements = {
  balance: byId("balance"),
  registerButton: byId("registerButton"),
  registerModal: byId("registerModal"),
  registerForm: byId("registerForm"),
  usernameInput: byId("usernameInput"),
  tickerTape: byId("tickerTape"),
  marketTable: byId("marketTable"),
  teamSearch: byId("teamSearch"),
  selectedName: byId("selectedName"),
  selectedRank: byId("selectedRank"),
  selectedPrice: byId("selectedPrice"),
  selectedChange: byId("selectedChange"),
  selectedVolume: byId("selectedVolume"),
  selectedHolding: byId("selectedHolding"),
  priceChart: byId("priceChart"),
  shareAmount: byId("shareAmount"),
  quoteLabel: byId("quoteLabel"),
  quoteCost: byId("quoteCost"),
  tradeButton: byId("tradeButton"),
  tradeMessage: byId("tradeMessage"),
  portfolioValue: byId("portfolioValue"),
  portfolioInvested: byId("portfolioInvested"),
  portfolioPnL: byId("portfolioPnL"),
  holdingsList: byId("holdingsList"),
  activityFeed: byId("activityFeed")
};

let state = loadState();
let selectedTeamId = state.selectedTeamId || state.teams[0].id;
let tradeMode = "long";
let tradeAction = "open";

function createInitialTeams() {
  return teamNames.map((name, index) => {
    return {
      id: `team-${index + 1}`,
      name,
      tagline: `Equipo ${index + 1} de la hackaton Platanus`,
      price: BASE_PRICE,
      startPrice: BASE_PRICE,
      volume: 0,
      liquidity: 260 + index * 8,
      buyPressure: 0,
      sellPressure: 0,
      history: Array.from({ length: 16 }, () => BASE_PRICE)
    };
  });
}

function loadState() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed.teams?.length === 29 && parsed.version === 2) return parsed;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  return {
    user: null,
    version: 2,
    balance: 0,
    selectedTeamId: "team-1",
    holdings: {},
    costBasis: {},
    shorts: {},
    shortProceeds: {},
    shortMargin: {},
    trades: [],
    teams: createInitialTeams()
  };
}

function saveState() {
  state.selectedTeamId = selectedTeamId;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function sortedTeams() {
  return [...state.teams].sort((a, b) => b.price * (1 + b.volume / 1000) - a.price * (1 + a.volume / 1000));
}

function selectedTeam() {
  return state.teams.find((team) => team.id === selectedTeamId) || state.teams[0];
}

function changePercent(team) {
  return ((team.price - team.startPrice) / team.startPrice) * 100;
}

function estimateQuote(team, amount) {
  const notional = team.price * amount;
  if (tradeMode === "short" && tradeAction === "open") {
    return notional * SHORT_MARGIN_RATE;
  }
  return notional;
}

function registerUser(name) {
  state.user = { name, createdAt: Date.now() };
  state.balance = STARTING_BALANCE;
  addActivity("Bono de registro", `Recibiste ${STARTING_BALANCE} BAZ para operar en la hackaton.`, "system");
  saveState();
  render();
}

function executeTrade() {
  if (!state.user) {
    openRegister();
    return;
  }

  const team = selectedTeam();
  const amount = Math.max(1, Math.floor(Number(elements.shareAmount.value) || 1));
  const quote = estimateQuote(team, amount);
  const ownedLong = state.holdings[team.id] || 0;
  const ownedShort = state.shorts[team.id] || 0;

  if (tradeMode === "long" && tradeAction === "open" && quote > state.balance) {
    setMessage("Saldo insuficiente para esa orden.");
    return;
  }

  if (tradeMode === "long" && tradeAction === "close" && amount > ownedLong) {
    setMessage("No tienes suficientes acciones largas para cerrar.");
    return;
  }

  if (tradeMode === "short" && tradeAction === "open" && quote > state.balance) {
    setMessage("Saldo insuficiente para cubrir el margen del short.");
    return;
  }

  if (tradeMode === "short" && tradeAction === "close" && amount > ownedShort) {
    setMessage("No tienes suficientes acciones cortas para recomprar.");
    return;
  }

  const isBuyPressure = (tradeMode === "long" && tradeAction === "open") || (tradeMode === "short" && tradeAction === "close");
  const direction = isBuyPressure ? 1 : -1;
  const oldPrice = team.price;
  const notional = oldPrice * amount;
  const impactRatio = Math.min(0.28, amount / team.liquidity);
  applyOrderPressure(team, direction, amount, impactRatio);

  if (tradeMode === "long" && tradeAction === "open") {
    state.balance -= notional;
    state.holdings[team.id] = ownedLong + amount;
    state.costBasis[team.id] = (state.costBasis[team.id] || 0) + notional;
  }

  if (tradeMode === "long" && tradeAction === "close") {
    state.balance += notional;
    state.holdings[team.id] = ownedLong - amount;
    reduceLongBasis(team.id, ownedLong, amount);
  }

  if (tradeMode === "short" && tradeAction === "open") {
    const margin = notional * SHORT_MARGIN_RATE;
    state.balance -= margin;
    state.shorts[team.id] = ownedShort + amount;
    state.shortProceeds[team.id] = (state.shortProceeds[team.id] || 0) + notional;
    state.shortMargin[team.id] = (state.shortMargin[team.id] || 0) + margin;
  }

  if (tradeMode === "short" && tradeAction === "close") {
    const priorProceeds = state.shortProceeds[team.id] || 0;
    const priorMargin = state.shortMargin[team.id] || 0;
    const closedFraction = ownedShort === 0 ? 1 : amount / ownedShort;
    const releasedProceeds = priorProceeds * closedFraction;
    const releasedMargin = priorMargin * closedFraction;
    const pnl = releasedProceeds - notional;
    state.balance += releasedMargin + pnl;
    state.shorts[team.id] = ownedShort - amount;
    state.shortProceeds[team.id] = Math.max(0, priorProceeds - releasedProceeds);
    state.shortMargin[team.id] = Math.max(0, priorMargin - releasedMargin);
    if (state.shorts[team.id] <= 0) {
      delete state.shorts[team.id];
      delete state.shortProceeds[team.id];
      delete state.shortMargin[team.id];
    }
  }

  addActivity(getTradeTitle(team), `${amount} acciones a ${fmt(oldPrice)} BAZ. Nuevo precio ${fmt(team.price)} BAZ.`, tradeMode);
  setMessage("Orden ejecutada.");
  saveState();
  render();
}

function applyOrderPressure(team, direction, amount, impactRatio) {
  const oldPrice = team.price;
  team.price = clampPrice(team.price * (1 + direction * impactRatio));
  team.volume += oldPrice * amount;
  if (direction > 0) team.buyPressure += amount;
  else team.sellPressure += amount;
  team.history.push(team.price);
  team.history = team.history.slice(-48);
}

function reduceLongBasis(teamId, owned, amount) {
  const priorBasis = state.costBasis[teamId] || 0;
  const soldFraction = owned === 0 ? 1 : amount / owned;
  state.costBasis[teamId] = Math.max(0, priorBasis * (1 - soldFraction));
  if (state.holdings[teamId] <= 0) {
    delete state.holdings[teamId];
    delete state.costBasis[teamId];
  }
}

function getTradeTitle(team) {
  if (tradeMode === "long" && tradeAction === "open") return `Largo abierto en ${team.name}`;
  if (tradeMode === "long" && tradeAction === "close") return `Largo cerrado en ${team.name}`;
  if (tradeMode === "short" && tradeAction === "open") return `Short abierto en ${team.name}`;
  return `Short recomprado en ${team.name}`;
}

function clampPrice(price) {
  return Number(Math.min(200, Math.max(0.25, price)).toFixed(2));
}

function addActivity(title, detail, type = "market") {
  state.trades.unshift({ title, detail, type, time: Date.now() });
  state.trades = state.trades.slice(0, 24);
}

function setMessage(message) {
  elements.tradeMessage.textContent = message;
  window.clearTimeout(setMessage.timeout);
  setMessage.timeout = window.setTimeout(() => {
    elements.tradeMessage.textContent = "";
  }, 2600);
}

function render() {
  const team = selectedTeam();
  const ranking = sortedTeams();
  const rank = ranking.findIndex((item) => item.id === team.id) + 1;
  const holding = state.holdings[team.id] || 0;
  const shortHolding = state.shorts[team.id] || 0;
  const amount = Math.max(1, Math.floor(Number(elements.shareAmount.value) || 1));
  const quote = estimateQuote(team, amount);

  elements.balance.textContent = intFmt(state.balance);
  elements.registerButton.textContent = state.user ? state.user.name : "Registrarme";
  elements.selectedName.textContent = team.name;
  elements.selectedRank.textContent = `#${rank}`;
  elements.selectedPrice.textContent = fmt(team.price);
  renderChange(elements.selectedChange, changePercent(team));
  elements.selectedVolume.textContent = intFmt(team.volume);
  elements.selectedHolding.textContent = `${intFmt(holding)}L / ${intFmt(shortHolding)}C`;
  if (elements.quoteLabel) elements.quoteLabel.textContent = getQuoteLabel();
  elements.quoteCost.textContent = fmt(quote);
  elements.tradeButton.textContent = getTradeButtonLabel();
  elements.tradeButton.disabled = !state.user || !canExecute(amount, quote, holding, shortHolding);

  renderTicker(ranking.slice(0, 10));
  renderMarket(ranking);
  renderPortfolio();
  renderActivity();
  drawChart(team);
}

function getQuoteLabel() {
  if (tradeMode === "short" && tradeAction === "open") return "Margen requerido";
  if (tradeMode === "short" && tradeAction === "close") return "Costo recompra";
  if (tradeMode === "long" && tradeAction === "close") return "Ingreso estimado";
  return "Costo estimado";
}

function getTradeButtonLabel() {
  if (tradeMode === "long" && tradeAction === "open") return "Comprar largo";
  if (tradeMode === "long" && tradeAction === "close") return "Vender largo";
  if (tradeMode === "short" && tradeAction === "open") return "Abrir short";
  return "Recomprar short";
}

function canExecute(amount, quote, holding, shortHolding) {
  if (tradeMode === "long" && tradeAction === "open") return quote <= state.balance;
  if (tradeMode === "long" && tradeAction === "close") return amount <= holding;
  if (tradeMode === "short" && tradeAction === "open") return quote <= state.balance;
  return amount <= shortHolding;
}

function renderTicker(teams) {
  elements.tickerTape.innerHTML = teams.map((team) => {
    const change = changePercent(team);
    const className = change >= 0 ? "up" : "down";
    return `
      <button class="ticker-chip" type="button" data-team-id="${team.id}">
        <strong>${team.name}</strong>
        <span>${fmt(team.price)} BAZ <b class="change ${className}">${change >= 0 ? "+" : ""}${fmt(change, 1)}%</b></span>
      </button>
    `;
  }).join("");
}

function renderMarket(teams) {
  const query = elements.teamSearch.value.trim().toLowerCase();
  const filtered = teams.filter((team) => team.name.toLowerCase().includes(query) || team.tagline.toLowerCase().includes(query));

  elements.marketTable.innerHTML = filtered.map((team) => {
    const rank = teams.findIndex((item) => item.id === team.id) + 1;
    const change = changePercent(team);
    const className = change >= 0 ? "up" : "down";
    const owned = state.holdings[team.id] || 0;
    const short = state.shorts[team.id] || 0;
    return `
      <button class="team-row ${team.id === selectedTeamId ? "selected" : ""}" type="button" data-team-id="${team.id}">
        <span class="rank">${rank}</span>
        <span class="team-main">
          <strong>${team.name}</strong>
          <span>${team.tagline}</span>
        </span>
        <span class="price">${fmt(team.price)} BAZ</span>
        <span class="change ${className}">${change >= 0 ? "+" : ""}${fmt(change, 1)}%</span>
        <span class="volume">${intFmt(team.volume)} BAZ</span>
        <span class="owned">${intFmt(owned)}L / ${intFmt(short)}C</span>
      </button>
    `;
  }).join("");
}

function renderChange(element, value) {
  element.textContent = `${value >= 0 ? "+" : ""}${fmt(value, 1)}%`;
  element.className = value >= 0 ? "change up" : "change down";
}

function renderPortfolio() {
  const longPositions = Object.entries(state.holdings)
    .map(([teamId, amount]) => ({ team: state.teams.find((item) => item.id === teamId), amount }))
    .filter((item) => item.team && item.amount > 0);
  const shortPositions = Object.entries(state.shorts)
    .map(([teamId, amount]) => ({ team: state.teams.find((item) => item.id === teamId), amount }))
    .filter((item) => item.team && item.amount > 0);

  const longValue = longPositions.reduce((sum, item) => sum + item.team.price * item.amount, 0);
  const shortLiability = shortPositions.reduce((sum, item) => sum + item.team.price * item.amount, 0);
  const invested = Object.values(state.costBasis).reduce((sum, value) => sum + value, 0);
  const shortProceeds = Object.values(state.shortProceeds).reduce((sum, value) => sum + value, 0);
  const shortMargin = Object.values(state.shortMargin).reduce((sum, value) => sum + value, 0);
  const longPnl = longValue - invested;
  const shortPnl = shortProceeds - shortLiability;
  const pnl = longPnl + shortPnl;
  const total = state.balance + longValue + shortMargin + shortPnl;

  elements.portfolioValue.textContent = fmt(total);
  elements.portfolioInvested.textContent = fmt(invested + shortMargin);
  elements.portfolioPnL.textContent = `${pnl >= 0 ? "+" : ""}${fmt(pnl)} BAZ`;
  elements.portfolioPnL.className = `pnl ${pnl >= 0 ? "up" : "down"}`;

  const longRows = longPositions.sort((a, b) => b.team.price * b.amount - a.team.price * a.amount).map(({ team, amount }) => {
        const basis = state.costBasis[team.id] || 0;
        const value = team.price * amount;
        const positionPnl = value - basis;
        return `
          <button class="holding-row" type="button" data-team-id="${team.id}">
            <span>
              <strong>Largo - ${team.name}</strong>
              <span>${intFmt(amount)} acciones - costo ${fmt(basis)} BAZ</span>
            </span>
            <span class="pnl ${positionPnl >= 0 ? "up" : "down"}">${positionPnl >= 0 ? "+" : ""}${fmt(positionPnl)} BAZ</span>
          </button>
        `;
      });

  const shortRows = shortPositions.sort((a, b) => b.team.price * b.amount - a.team.price * a.amount).map(({ team, amount }) => {
    const proceeds = state.shortProceeds[team.id] || 0;
    const liability = team.price * amount;
    const positionPnl = proceeds - liability;
    return `
      <button class="holding-row" type="button" data-team-id="${team.id}">
        <span>
          <strong>Corto - ${team.name}</strong>
          <span>${intFmt(amount)} acciones - recompra ${fmt(liability)} BAZ</span>
        </span>
        <span class="pnl ${positionPnl >= 0 ? "up" : "down"}">${positionPnl >= 0 ? "+" : ""}${fmt(positionPnl)} BAZ</span>
      </button>
    `;
  });

  elements.holdingsList.innerHTML = longRows.length || shortRows.length
    ? [...longRows, ...shortRows].join("")
    : `<div class="holding-row"><span><strong>Sin posiciones aun</strong><span>Registrate y compra acciones para armar tu portafolio.</span></span></div>`;
}

function renderActivity() {
  elements.activityFeed.innerHTML = state.trades.length
    ? state.trades.map((trade) => `
      <div class="activity-row">
        <span>
          <strong>${trade.title}</strong>
          <span>${trade.detail}</span>
        </span>
        <span>${relativeTime(trade.time)}</span>
      </div>
    `).join("")
    : `<div class="activity-row"><span><strong>Esperando actividad</strong><span>Las ordenes apareceran aqui.</span></span></div>`;
}

function relativeTime(time) {
  const seconds = Math.max(1, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function drawChart(team) {
  const canvas = elements.priceChart;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const pad = 22;
  const values = team.history;
  const min = Math.min(...values) * 0.98;
  const max = Math.max(...values) * 1.02;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#091624";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(190,218,255,0.12)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = pad + (i * (height - pad * 2)) / 3;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  const points = values.map((value, index) => ({
    x: pad + (index * (width - pad * 2)) / Math.max(1, values.length - 1),
    y: height - pad - ((value - min) / Math.max(0.01, max - min)) * (height - pad * 2)
  }));

  const gradient = ctx.createLinearGradient(0, pad, 0, height - pad);
  gradient.addColorStop(0, "rgba(32, 183, 255, 0.4)");
  gradient.addColorStop(1, "rgba(32, 183, 255, 0)");

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.lineTo(width - pad, height - pad);
  ctx.lineTo(pad, height - pad);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = "#37c5ff";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  const last = points.at(-1);
  ctx.fillStyle = "#d9fbff";
  ctx.beginPath();
  ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
  ctx.fill();
}

function openRegister() {
  if (state.user) return;
  elements.registerModal.classList.remove("hidden");
  elements.usernameInput.focus();
}

function switchPanel(view) {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  const panel = document.querySelector(`[data-panel="${view}"]`);
  if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.addEventListener("click", (event) => {
  const teamButton = event.target.closest("[data-team-id]");
  if (teamButton) {
    selectedTeamId = teamButton.dataset.teamId;
    saveState();
    render();
  }

  const navButton = event.target.closest(".nav-item");
  if (navButton) switchPanel(navButton.dataset.view);

  const tabButton = event.target.closest(".ticket-tab");
  if (tabButton) {
    if (tabButton.dataset.mode) tradeMode = tabButton.dataset.mode;
    if (tabButton.dataset.action) tradeAction = tabButton.dataset.action;
    document.querySelectorAll("[data-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === tradeMode);
    });
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.classList.toggle("active", button.dataset.action === tradeAction);
    });
    render();
  }
});

elements.registerButton.addEventListener("click", openRegister);
elements.registerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = elements.usernameInput.value.trim();
  if (name.length < 2) return;
  elements.registerModal.classList.add("hidden");
  registerUser(name);
});
elements.shareAmount.addEventListener("input", render);
elements.teamSearch.addEventListener("input", render);
elements.tradeButton.addEventListener("click", executeTrade);

if (!state.user) openRegister();
render();
