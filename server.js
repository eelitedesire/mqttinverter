const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const mqtt = require('mqtt');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// MQTT setup
const MQTT_BROKER = 'mqtt://your_mqtt_broker_address';
const MQTT_TOPIC_IN = "solar_assistant_DEYE/#";
const client = mqtt.connect(MQTT_BROKER);

client.on('connect', () => {
  console.log('Connected to MQTT broker');
  client.subscribe(MQTT_TOPIC_IN, (err) => {
    if (!err) {
      console.log(`Subscribed to ${MQTT_TOPIC_IN}`);
    }
  });
});

function publishToMQTT(topic, message) {
  let messageToSend = message;
  if (typeof message === 'number' && isNaN(message)) {
    console.warn(`Attempting to publish NaN value to ${topic}. Skipping.`);
    return;
  }
  if (typeof message !== 'string') {
    messageToSend = JSON.stringify(message);
  }

  client.publish(topic, messageToSend, (err) => {
    if (err) {
      console.error('Error publishing to MQTT:', err);
    } else {
      console.log(`Published to ${topic}: ${messageToSend}`);
      broadcastMessage({
        type: 'automationLog',
        message: `Published to ${topic}: ${messageToSend}`
      });
    }
  });
}

// Inverter configuration
let inverterConfig = {
  Deye: {
    workMode: ['Selling first', 'Zero Export to Load', 'Selling first'],
    solarExportWhenBatteryFull: true,
    energyPattern: ['Load First', 'Battery First'],
    maxSellPower: 5000
  },
  MPP: {
    // Add MPP-specific settings here
  }
};

// Data storage
let automationRules = [];
let scheduledSettings = [];
let universalSettings = {
  maxBatteryDischargePower: 500,
  gridChargeOn: false,
  generatorChargeOn: false,
  dischargeVoltage: 48.0
};
let currentInverterType = 'Deye';
let currentInverterSettings = { ...inverterConfig.Deye };

// Current system state
let currentSystemState = {
  inverter_1: {},
  inverter_2: {},
  battery_1: {},
  total: {},
  batteryPower: 0,
  batterySOC: 0,
  solarPower: 0,
  gridPower: 0,
  loadPower: 0,
  time: new Date(),
};

// Function to update the current system state
function updateSystemState(deviceType, measurement, value) {
  if (!currentSystemState[deviceType]) {
    currentSystemState[deviceType] = {};
  }
  currentSystemState[deviceType][measurement] = value;
  currentSystemState.time = new Date();

  // Special handling for 'total' measurements
  if (deviceType === 'total') {
    switch(measurement) {
      case 'battery_power':
        currentSystemState.batteryPower = value;
        break;
      case 'battery_state_of_charge':
        currentSystemState.batterySOC = value;
        break;
      case 'grid_power':
        currentSystemState.gridPower = value;
        break;
      case 'load_power':
        currentSystemState.loadPower = value;
        break;
      case 'pv_power':
        currentSystemState.solarPower = value;
        break;
    }
  }

  broadcastMessage({ type: 'stateUpdate', state: currentSystemState });
}

// Handle MQTT messages and update system state
client.on('message', (topic, message) => {
  console.log(`Received message on ${topic}: ${message.toString()}`);
  const topicParts = topic.split('/');
  const deviceType = topicParts[1]; // e.g., 'inverter_1', 'battery_1', 'total'
  const measurement = topicParts.slice(2, -1).join('_'); // e.g., 'pv_voltage_1', 'state_of_charge'

  let value;
  try {
    value = parseFloat(message.toString());
    if (isNaN(value)) {
      value = message.toString(); // Keep as string if not a valid number
    }
  } catch (error) {
    console.error(`Error parsing message payload: ${error.message}`);
    return;
  }

  updateSystemState(deviceType, measurement, value);
});

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Universal Settings
app.get('/api/universal-settings', (req, res) => {
  res.json(universalSettings);
});

app.post('/api/universal-settings', (req, res) => {
  universalSettings = { ...universalSettings, ...req.body };
  res.json(universalSettings);
  Object.entries(universalSettings).forEach(([key, value]) => {
    publishToMQTT(`solar_assistant_DEYE/universal/${key}`, value);
  });
});

// Inverter Settings
app.get('/api/inverter-types', (req, res) => {
  res.json(Object.keys(inverterConfig));
});

app.get('/api/inverter-settings', (req, res) => {
  res.json({ type: currentInverterType, settings: currentInverterSettings });
});

app.post('/api/inverter-settings', (req, res) => {
  const { type, settings } = req.body;
  if (inverterConfig[type]) {
    currentInverterType = type;
    currentInverterSettings = { ...inverterConfig[type], ...settings };
    inverterConfig[type] = currentInverterSettings;
    res.json({ type: currentInverterType, settings: currentInverterSettings });
    Object.entries(currentInverterSettings).forEach(([key, value]) => {
      publishToMQTT(`solar_assistant_DEYE/inverter/${key}`, value);
    });
  } else {
    res.status(400).json({ error: 'Invalid inverter type' });
  }
});

app.post('/api/inverter-types', (req, res) => {
  const { type, settings } = req.body;
  if (!inverterConfig[type]) {
    inverterConfig[type] = settings;
    res.status(201).json({ message: 'Inverter type added successfully', type, settings });
  } else {
    res.status(400).json({ error: 'Inverter type already exists' });
  }
});

app.put('/api/inverter-types/:type', (req, res) => {
  const { type } = req.params;
  const { settings } = req.body;
  if (inverterConfig[type]) {
    inverterConfig[type] = { ...inverterConfig[type], ...settings };
    res.json({ type, settings: inverterConfig[type] });
  } else {
    res.status(404).json({ error: 'Inverter type not found' });
  }
});

app.delete('/api/inverter-types/:type', (req, res) => {
  const { type } = req.params;
  if (inverterConfig[type]) {
    delete inverterConfig[type];
    res.sendStatus(204);
  } else {
    res.status(404).json({ error: 'Inverter type not found' });
  }
});

// Automation Rules
app.get('/api/automation-rules', (req, res) => {
  res.json(automationRules);
});

app.post('/api/automation-rules', (req, res) => {
  const newRule = {
    id: Date.now().toString(),
    name: req.body.name,
    conditions: req.body.conditions,
    actions: req.body.actions,
    days: req.body.days
  };
  automationRules.push(newRule);
  res.status(201).json(newRule);
});

app.get('/api/automation-rules/:id', (req, res) => {
  const rule = automationRules.find(r => r.id === req.params.id);
  if (rule) {
    res.json(rule);
  } else {
    res.status(404).json({ error: 'Rule not found' });
  }
});

app.put('/api/automation-rules/:id', (req, res) => {
  const { id } = req.params;
  const index = automationRules.findIndex(rule => rule.id === id);
  if (index !== -1) {
    automationRules[index] = { ...automationRules[index], ...req.body };
    res.json(automationRules[index]);
  } else {
    res.status(404).json({ error: 'Rule not found' });
  }
});

app.delete('/api/automation-rules/:id', (req, res) => {
  const { id } = req.params;
  automationRules = automationRules.filter(rule => rule.id !== id);
  res.sendStatus(204);
});

// Scheduled Settings
app.get('/api/scheduled-settings', (req, res) => {
  res.json(scheduledSettings);
});

app.post('/api/scheduled-settings', (req, res) => {
  const newSetting = {
    id: Date.now().toString(),
    key: req.body.key,
    value: req.body.value,
    day: req.body.day,
    hour: req.body.hour
  };
  scheduledSettings.push(newSetting);
  res.status(201).json(newSetting);
});

app.put('/api/scheduled-settings/:id', (req, res) => {
  const { id } = req.params;
  const index = scheduledSettings.findIndex(setting => setting.id === id);
  if (index !== -1) {
    scheduledSettings[index] = { ...scheduledSettings[index], ...req.body };
    res.json(scheduledSettings[index]);
  } else {
    res.status(404).json({ error: 'Scheduled setting not found' });
  }
});

app.delete('/api/scheduled-settings/:id', (req, res) => {
  const { id } = req.params;
  scheduledSettings = scheduledSettings.filter(setting => setting.id !== id);
  res.sendStatus(204);
});

// MQTT publishing route
app.post('/api/mqtt', (req, res) => {
  const { topic, message } = req.body;
  publishToMQTT(topic, message);
  res.sendStatus(200);
});

// Helper functions
function applyScheduledSettings() {
  const now = new Date();
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
  const hour = now.getHours();

  scheduledSettings.forEach(setting => {
    if (setting.day === day && setting.hour === hour) {
      publishToMQTT(`solar_assistant_DEYE/${setting.key}`, setting.value);
      broadcastMessage({
        type: 'realtimeUpdate',
        updateType: 'scheduledSettingApplied',
        key: setting.key,
        value: setting.value
      });
    }
  });
}

function applyAutomationRules() {
  const now = new Date();
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];

  automationRules.forEach(rule => {
    if (rule.days.includes(day) && checkConditions(rule.conditions)) {
      rule.actions.forEach(action => {
        publishToMQTT(`solar_assistant_DEYE/${action.key}`, action.value);
      });
      broadcastMessage({
        type: 'realtimeUpdate',
        updateType: 'automationRuleTriggered',
        ruleName: rule.name,
        actions: rule.actions
      });
    }
  });
}

function checkConditions(conditions) {
  return conditions.every(condition => {
    const { deviceType, parameter, operator, value } = condition;
    
    if (currentSystemState[deviceType] && currentSystemState[deviceType][parameter] !== undefined) {
      return compareNumeric(currentSystemState[deviceType][parameter], operator, parseFloat(value));
    } else if (currentSystemState[parameter] !== undefined) {
      return compareNumeric(currentSystemState[parameter], operator, parseFloat(value));
    }
    
    console.warn(`Unknown parameter: ${deviceType}.${parameter}`);
    return false;
  });
}

function compareNumeric(actual, operator, expected) {
  switch (operator) {
    case 'equals':
      return Math.abs(actual - expected) < 0.001;
    case 'notEquals':
      return Math.abs(actual - expected) >= 0.001;
    case 'greaterThan':
      return actual > expected;
    case 'lessThan':
      return actual < expected;
    case 'greaterThanOrEqual':
      return actual >= expected;
    case 'lessThanOrEqual':
      return actual <= expected;
    default:
      console.warn(`Unknown operator: ${operator}`);
      return false;
  }
}

function compareTime(actualDate, operator, expectedTime) {
  const [expectedHours, expectedMinutes] = expectedTime.split(':').map(Number);
  const actualMinutes = actualDate.getHours() * 60 + actualDate.getMinutes();
  const expectedTotalMinutes = expectedHours * 60 + expectedMinutes;

  switch (operator) {
    case 'equals':
      return actualMinutes === expectedTotalMinutes;
    case 'notEquals':
      return actualMinutes !== expectedTotalMinutes;
    case 'after':
      return actualMinutes > expectedTotalMinutes;
    case 'before':
      return actualMinutes < expectedTotalMinutes;
    default:
      console.warn(`Unknown operator for time comparison: ${operator}`);
      return false;
  }
}

function compareDay(actualDay, operator, expectedDay) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const expectedDayIndex = days.indexOf(expectedDay.toLowerCase());

  if (expectedDayIndex === -1) {
    console.warn(`Invalid day: ${expectedDay}`);
    return false;
  }

  switch (operator) {
    case 'equals':
      return actualDay === expectedDayIndex;
    case 'notEquals':
      return actualDay !== expectedDayIndex;
    default:
      console.warn(`Unknown operator for day comparison: ${operator}`);
      return false;
  }
}

// WebSocket setup
const server = app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.on('close', () => console.log('Client disconnected'));
});

function broadcastMessage(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Scheduled tasks
setInterval(applyScheduledSettings, 60000); // Run every minute
setInterval(applyAutomationRules, 60000); // Run every minute

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// 404 handler
app.use((req, res, next) => {
  res.status(404).send("Sorry, that route doesn't exist.");
});

// Export the app and server for testing or further configuration
module.exports = { app, server };