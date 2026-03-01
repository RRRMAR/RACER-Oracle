// --- Configuration ---
// Using Mosquitto's public test broker with WebSockets
const MQTT_BROKER = "test.mosquitto.org";
const MQTT_PORT = 8081; // Secure WebSockets port
const MQTT_PATH = "/mqtt";

// Topics
const ROOM_ID = "oracle-racing-general";
const TOPIC_PREFIX = "oracle/racing/" + ROOM_ID;
const TOPIC_PLAYERS = TOPIC_PREFIX + "/players/";
const TOPIC_GAME_STATE = TOPIC_PREFIX + "/state";
const TOPIC_HOF = "oracle/racing/global/hall_of_fame"; // Retained topic for HOF

// Game Constants
const WIN_SCORE = 100; // The X coordinate/score needed to win

// --- Global State ---
let mqttClient = null;
let playerName = "";
let playerId = Math.random().toString(36).substring(2, 9); // Unique ID for this session
let playerScore = 0;
let isRacing = false;
let startTime = 0;
let connectedPlayers = {}; // { id: { name, score, wager, lastSeen } }
let hallOfFame = []; // Array of records
let lastPublishTime = 0;

// Betting State
let myCoins = 1000;
let myWager = 0;
let currentPrizePool = 0;
let hasSettledBet = false;

// --- DOM Elements ---
const domLoginScreen = document.getElementById('login-screen');
const domGameScreen = document.getElementById('game-screen');
const btnJoin = document.getElementById('join-btn');
const inputName = document.getElementById('player-name-input');
const statusMsg = document.getElementById('connection-status');

const domCurrentPlayer = document.getElementById('current-player');
const trackContainer = document.getElementById('track-container');
const waitingMsg = document.getElementById('waiting-msg');
const btnRush = document.getElementById('rush-btn');
const hofList = document.getElementById('hall-of-fame-list');

const winnerOverlay = document.getElementById('winner-overlay');
const winnerNameDisplay = document.getElementById('winner-name');
const payoutResult = document.getElementById('payout-result');
const btnRestart = document.getElementById('restart-btn');

// Betting DOM
const domLoginBalance = document.getElementById('login-balance');
const domGameBalance = document.getElementById('game-balance');
const inputWager = document.getElementById('wager-input');
const domPrizePool = document.getElementById('prize-pool-amount');

// --- Initialization ---
function init() {
    // Load Coins
    loadCoins();

    // Attempt Mqtt Connection immediately
    statusMsg.innerText = "Connecting to MQTT Broker...";

    // Create client instance (using Eclipse Paho MQTT)
    // Client(hostname, port, path, clientId)
    mqttClient = new Paho.MQTT.Client(MQTT_BROKER, MQTT_PORT, MQTT_PATH, "racer_" + playerId);

    // Set callback handlers
    mqttClient.onConnectionLost = onConnectionLost;
    mqttClient.onMessageArrived = onMessageArrived;

    // Connect the client
    mqttClient.connect({
        useSSL: true,
        onSuccess: onConnect,
        onFailure: (err) => {
            statusMsg.innerText = "Connection failed: " + err.errorMessage;
            console.error("MQTT Connect failed", err);
        }
    });

    // Event Listeners
    inputName.addEventListener('input', () => {
        btnJoin.disabled = inputName.value.trim().length === 0 || !mqttClient.isConnected();
    });

    const btnWagerMinus = document.getElementById('wager-minus');
    const btnWagerPlus = document.getElementById('wager-plus');

    btnWagerMinus.addEventListener('click', () => adjustWager(-10));
    btnWagerPlus.addEventListener('click', () => adjustWager(10));

    btnJoin.addEventListener('click', enterGame);
    btnRush.addEventListener('click', rushAction);
    btnRestart.addEventListener('click', resetGame);

    // Keyboard listener for Spacebar
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !domGameScreen.classList.contains('hidden')) {
            // Prevent default page scroll
            e.preventDefault();
            rushAction();
        }
    });

    // Cleanup loop
    setInterval(cleanupStalePlayers, 5000);
}

// --- MQTT Callbacks ---
function onConnect() {
    console.log("Connected to MQTT Broker");
    statusMsg.innerText = "Connected to Ether. Ready.";
    if (inputName.value.trim().length > 0) {
        btnJoin.disabled = false;
    }
    btnJoin.innerText = "Enter the Realm";

    // Subscribe to topics
    mqttClient.subscribe(TOPIC_PLAYERS + "#");
    mqttClient.subscribe(TOPIC_GAME_STATE);
    mqttClient.subscribe(TOPIC_HOF);
}

function onConnectionLost(responseObject) {
    if (responseObject.errorCode !== 0) {
        console.error("Connection Lost:", responseObject.errorMessage);
        statusMsg.innerText = "Lost connection to ether. Please refresh.";
        btnJoin.disabled = true;
    }
}

function onMessageArrived(message) {
    const topic = message.destinationName;
    const payloadStr = message.payloadString;

    try {
        const data = JSON.parse(payloadStr);

        // Handle Player Updates
        if (topic.startsWith(TOPIC_PLAYERS)) {
            const incomingId = topic.split('/').pop();
            handlePlayerUpdate(incomingId, data);
        }

        // Handle Game State (Winner announced)
        else if (topic === TOPIC_GAME_STATE) {
            handleGameStateUpdate(data);
        }

        // Handle Hall of Fame (Retained message)
        else if (topic === TOPIC_HOF) {
            handleHofUpdate(data);
        }

    } catch (e) {
        console.error("Failed to parse message", e);
    }
}

// --- Game Logic ---
function enterGame() {
    playerName = inputName.value.trim();
    if (!playerName) return;

    // Process Wager
    const wagerVal = parseInt(inputWager.value, 10);
    if (isNaN(wagerVal) || wagerVal < 1) {
        alert("Wager must be at least 1 coin.");
        return;
    }
    if (wagerVal > myCoins) {
        alert("You don't have enough Oracle Coins for that wager!");
        return;
    }
    myWager = wagerVal;
    hasSettledBet = false;

    domLoginScreen.classList.add('hidden');
    domGameScreen.classList.remove('hidden');
    domCurrentPlayer.innerText = playerName;

    isRacing = true;
    startTime = Date.now();
    playerScore = 0;

    // Subtract wager from balance temporarily (held in escrow)
    updateCoins(myCoins - myWager);

    // Broadcast my initial presence
    publishMyState();

    // Render my track
    renderTracks();
}

function rushAction() {
    if (!isRacing) return;

    playerScore += 2; // Advance by 2 units per click

    // Check win condition
    if (playerScore >= WIN_SCORE) {
        playerScore = WIN_SCORE;
        declareWinner();
    }

    // Throttle MQTT publishes slightly to avoid spam, but update local UI instantly
    const now = Date.now();
    if (now - lastPublishTime > 50 || playerScore === WIN_SCORE) {
        publishMyState();
        lastPublishTime = now;
    }

    // Update local UI immediately
    connectedPlayers[playerId] = { name: playerName, score: playerScore, wager: myWager, lastSeen: Date.now() };
    updateTrackPositions();
    updatePrizePoolUI();
}

function handlePlayerUpdate(id, data) {
    if (id === playerId) return; // Ignore own echoes

    connectedPlayers[id] = {
        name: data.name,
        score: data.score,
        wager: data.wager || 0,
        lastSeen: Date.now()
    };

    renderTracks(); // Will render if new, or just update positions
    updatePrizePoolUI();
}

function handleGameStateUpdate(data) {
    if (data.type === "winner") {
        isRacing = false;
        showWinner(data.name, data.pool);
    }
}

function publishMyState() {
    if (!mqttClient || !mqttClient.isConnected()) return;

    const payload = JSON.stringify({
        name: playerName,
        score: playerScore,
        wager: myWager
    });

    const message = new Paho.MQTT.Message(payload);
    message.destinationName = TOPIC_PLAYERS + playerId;
    // Set QoS 0 for fast ephemeral position updates
    message.qos = 0;

    mqttClient.send(message);
}

function declareWinner() {
    isRacing = false;
    const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);

    // Publish Winner State including final observed prize pool
    const winMsg = new Paho.MQTT.Message(JSON.stringify({
        type: "winner",
        name: playerName,
        time: timeTaken,
        pool: currentPrizePool
    }));
    winMsg.destinationName = TOPIC_GAME_STATE;
    mqttClient.send(winMsg);

    // Setup local winner screen
    showWinner(playerName, currentPrizePool);

    // Update Hall of Fame (MQTT Retained)
    recordToHallOfFame(playerName, timeTaken);
}

function showWinner(winnerName, totalPool) {
    winnerNameDisplay.innerText = winnerName;

    // Handle Betting Payout
    if (!hasSettledBet) {
        hasSettledBet = true;
        if (winnerName === playerName) {
            // I won! Give me back my wager + the rest of the pool
            const profit = totalPool - myWager;
            updateCoins(myCoins + totalPool);
            payoutResult.innerText = `JACKPOT! You won +${profit} 🟡`;
            payoutResult.className = "payout-box payout-win";
        } else {
            // I lost. Wager is already deducted.
            payoutResult.innerText = `YOU LOST! -${myWager} 🟡`;
            payoutResult.className = "payout-box payout-loss";
        }
    }

    winnerOverlay.classList.remove('hidden');
}

function resetGame() {
    winnerOverlay.classList.add('hidden');

    // Reset state
    playerScore = 0;

    connectedPlayers = {}; // Clear remote players temporarily

    // Return to login screen to re-wager
    domGameScreen.classList.add('hidden');
    domLoginScreen.classList.remove('hidden');

    // Disconnect so we don't receive straggler updates
    mqttClient.disconnect();
    setTimeout(() => {
        init(); // Reconnect for fresh state
    }, 500);
}

// --- UI Rendering ---
function renderTracks() {
    // Combine me and connected players
    const allIds = [playerId, ...Object.keys(connectedPlayers)];

    if (allIds.length > 1) {
        waitingMsg.style.display = 'none';
    } else {
        waitingMsg.style.display = 'block';
    }

    allIds.forEach(id => {
        let trackEl = document.getElementById('track-' + id);
        if (!trackEl) {
            // Create track
            trackEl = document.createElement('div');
            trackEl.id = 'track-' + id;
            trackEl.className = 'track' + (id === playerId ? ' is-self' : '');

            trackEl.innerHTML = `
                <div class="player-name-label"></div>
                <div class="avatar"></div>
            `;
            trackContainer.appendChild(trackEl);
        }

        // Update Name
        const nameData = id === playerId ? playerName : connectedPlayers[id].name;
        trackEl.querySelector('.player-name-label').innerText = nameData;
        trackEl.querySelector('.avatar').innerText = nameData.charAt(0).toUpperCase();
    });

    updateTrackPositions();
}

function updateTrackPositions() {
    const allIds = [playerId, ...Object.keys(connectedPlayers)];
    allIds.forEach(id => {
        const trackEl = document.getElementById('track-' + id);
        if (trackEl) {
            const score = id === playerId ? playerScore : connectedPlayers[id].score;
            // Map score 0-100 to 0-90% width (reserving space for avatar)
            const percentage = Math.min((score / WIN_SCORE) * 90, 90);
            trackEl.querySelector('.avatar').style.left = `${percentage}%`;
        }
    });
}

function cleanupStalePlayers() {
    const now = Date.now();
    for (const [id, data] of Object.entries(connectedPlayers)) {
        if (now - data.lastSeen > 10000) { // Removing after 10 seconds of no updates
            delete connectedPlayers[id];
            const trackEl = document.getElementById('track-' + id);
            if (trackEl) trackEl.remove();
        }
    }
    updatePrizePoolUI();
}

// --- Betting Logic ---
function loadCoins() {
    let savedCoins = localStorage.getItem('oracleRaceCoins');
    if (!savedCoins) {
        savedCoins = 1000;
        localStorage.setItem('oracleRaceCoins', savedCoins);
    }
    myCoins = parseInt(savedCoins, 10);
    updateCoinsUI();
}

function updateCoins(newAmount) {
    myCoins = newAmount;
    localStorage.setItem('oracleRaceCoins', myCoins);
    updateCoinsUI();
}

function updateCoinsUI() {
    const text = myCoins + " 🟡";
    domLoginBalance.innerText = text;
    domGameBalance.innerText = text;

    // Auto clamp wager to available balance if needed
    if (parseInt(inputWager.value, 10) > myCoins) {
        inputWager.value = myCoins;
        if (myCoins === 0) inputWager.value = 1; // Prevent 0 wager, but join will fail
    }
}

function updatePrizePoolUI() {
    currentPrizePool = 0;
    const allIds = [playerId, ...Object.keys(connectedPlayers)];
    allIds.forEach(id => {
        if (id === playerId) {
            currentPrizePool += parseInt(myWager, 10) || 0;
        } else {
            currentPrizePool += parseInt(connectedPlayers[id].wager, 10) || 0;
        }
    });

    domPrizePool.innerText = currentPrizePool + " 🟡";
}

function adjustWager(amount) {
    let currentVal = parseInt(inputWager.value, 10);
    if (isNaN(currentVal)) currentVal = 10;

    let newVal = currentVal + amount;

    // Clamp between 1 and myCoins
    if (newVal < 1) newVal = 1;
    if (newVal > myCoins) newVal = myCoins;

    inputWager.value = newVal;
}

// --- Hall of Fame (Retained Messages) ---
function handleHofUpdate(data) {
    if (Array.isArray(data)) {
        hallOfFame = data;
        renderHof();
    }
}

function recordToHallOfFame(name, time) {
    // Add new record
    hallOfFame.push({ name, time, date: new Date().toISOString() });

    // Sort by fastest time
    hallOfFame.sort((a, b) => parseFloat(a.time) - parseFloat(b.time));

    // Keep top 10
    if (hallOfFame.length > 10) {
        hallOfFame = hallOfFame.slice(0, 10);
    }

    // Publish as Retained Message
    const msg = new Paho.MQTT.Message(JSON.stringify(hallOfFame));
    msg.destinationName = TOPIC_HOF;
    msg.retained = true; // CRITICAL: This acts as our persistent database
    msg.qos = 1;

    mqttClient.send(msg);
}

function renderHof() {
    hofList.innerHTML = '';
    if (hallOfFame.length === 0) {
        hofList.innerHTML = '<li class="hof-empty">No champions yet. Be the first!</li>';
        return;
    }

    hallOfFame.forEach((record, index) => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span class="hof-name">#${index + 1} ${record.name}</span>
            <span class="hof-time">${record.time}s</span>
        `;
        hofList.appendChild(li);
    });
}

// Start
init();
