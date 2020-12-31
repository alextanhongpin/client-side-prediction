// =============================================================================
//  An Entity in the world.
// =============================================================================
class Entity {
  x = 0;
  speed = 2; // units/s
  positionBuffer = [];

  // Apply user's input to this entity.
  applyInput(input) {
    this.x += input.pressTime * this.speed;
  }
}

// =============================================================================
//  A message queue with simulated network lag.
// =============================================================================
class LagNetwork {
  messages = [];

  // "Send" a message. Store each message with the timestamp when it should be
  // received, to simulate lag.
  send(lagMs, message) {
    this.messages.push({
      recvTs: Date.now() + lagMs,
      payload: message
    });
  }

  // Returns a "received" message, or undefined if there are no messages available.
  receive() {
    const now = Date.now();
    for (let i = 0; i < this.messages.length; i++) {
      const message = this.messages[i];
      if (message.recvTs <= now) {
        this.messages.splice(i, 1);
        return message.payload;
      }
    }
  }
}

// =============================================================================
//  The Client.
// =============================================================================
class Client {
  constructor(canvas, status) {
    // Local representation of the entities.
    this.entities = {};

    // Input state.
    this.keyLeft = false;
    this.keyRight = false;

    // Simulated network connection.
    this.network = new LagNetwork();
    this.server = null;
    this.lag = 0;

    // Unique ID of our entity. Assigned by Server on connection.
    this.entityId = null;

    // Data needed for reconciliation.
    this.clientSidePrediction = false;
    this.serverReconciliation = false;
    this.inputSequenceNumber = 0;
    this.pendingInputs = [];

    // Entity interpolation toggle.
    this.entityInterpolation = true;

    // UI.
    this.canvas = canvas;
    this.status = status;

    // Update rate.
    this.setUpdateRate(50);
  }

  setUpdateRate(hz) {
    this.updateRate = hz;
    clearInterval(this.updateInterval);
    this.updateInterval = setInterval(() => {
      this.update();
    }, 1000 / this.updateRate);
  }

  // Update client state.
  update() {
    this.processServerMessages();

    if (this.entityId === null) {
      return; // Not connected yet.
    }
    this.processInputs();

    // Interpolate other entities.
    if (this.entityInterpolation) {
      this.interpolateEntities();
    }

    // Render the World.
    renderWorld(this.canvas, this.entities);

    // Show more info.
    const info = "Non-acknowledged inputs: " + this.pendingInputs.length;
    this.status.textContext = info;
  }

  // Get inputs and send them to the server.
  // If enabled, do client-side prediction.
  processInputs() {
    // Compute delta time since last update.
    const nowTs = Date.now();
    const lastTs = this.lastTs || nowTs;
    const dtSec = (nowTs - lastTs) / 1000.0;
    this.lastTs = nowTs;

    let input;
    if (this.keyRight) {
      input = { pressTime: dtSec };
    } else if (this.keyLeft) {
      input = { pressTime: -dtSec };
    } else {
      return;
    }

    input.inputSequenceNumber = this.inputSequenceNumber++;
    input.entityId = this.entityId;
    this.server.network.send(this.lag, input);

    if (this.clientSidePrediction) {
      this.entities[this.entityId].applyInput(input);
    }

    this.pendingInputs.push(input);
  }

  // Process all messages from the server, i.e. world updates.
  // If enabled, do server reconciliation.
  processServerMessages() {
    while (true) {
      const message = this.network.receive();
      if (!message) {
        break;
      }

      // World state is a list of entity states.
      for (let state of message) {
        const { entityId } = state;
        if (!this.entities[entityId]) {
          const entity = new Entity();
          entity.entityId = entityId;
          this.entities[entityId] = entity;
        }
        const entity = this.entities[entityId];

        // Client Side Prediction only applies for local entity, interpolation for external entities.
        if (entityId === this.entityId) {
          // Received the authoritative position of this client's entity.
          entity.x = state.position;
          if (this.serverReconciliation) {
            // Server Reconciliation. Re-apply all the inputs not yet processed by the server.
            this.pendingInputs = this.pendingInputs.filter(
              input => input.inputSequenceNumber > state.lastProcessedInput
            );
            this.pendingInputs.forEach(input => entity.applyInput(input));
          } else {
            // Reconciliation  is disabled, so drop all the saved inputs.
            this.pendingInputs = [];
          }
        } else {
          // Received the positions of an entity other than this client's.
          if (!this.entityInterpolation) {
            // Entity interpolation is disabled - just accept the server's position.
            entity.x = state.position;
          } else {
            // Add it to the position buffer.
            entity.positionBuffer.push([Date.now(), state.position]);
          }
        }
      }
    }
  }

  interpolateEntities() {
    // Compute render timestamp.
    const now = Date.now();
    const renderTimestamp = now - 1000.0 / server.updateRate;
    for (let id in this.entities) {
      const entity = this.entities[id];

      // No point in interpolating this client's entities.
      if (entity.entityId === this.entityId) {
        continue;
      }

      // Find the two authoritative positions surrounding the rendering timestamp.
      const buffer = entity.positionBuffer;
      // Drop older positions.
      while (buffer.length >= 2 && buffer[1][0] <= renderTimestamp) {
        buffer.shift();
      }

      // Interpolate between the two surrounding authoritative positions.
      if (
        buffer.length >= 2 &&
        buffer[0][0] <= renderTimestamp &&
        renderTimestamp <= buffer[1][0]
      ) {
        const [t0, x0] = buffer[0];
        const [t1, x1] = buffer[1];

        entity.x = x0 + ((x1 - x0) * (renderTimestamp - t0)) / (t1 - t0);
      }
    }
  }
}

// =============================================================================
//  The Server.
// =============================================================================
class Server {
  constructor(canvas, status) {
    // Connected clients and their entities.
    this.clients = [];
    this.entities = [];

    // Last processed iput for each client.
    this.lastProcessedInput = [];

    // Simulated network connection.
    this.network = new LagNetwork();

    // UI.
    this.canvas = canvas;
    this.status = status;

    // Default update rate.
    this.setUpdateRate(10);
  }

  connect(client) {
    // Give the Client enough data to identify itself.
    client.server = this;
    client.entityId = this.clients.length;
    this.clients.push(client);

    // Create a new Entity for this Client.
    const entity = new Entity();
    this.entities.push(entity);
    entity.entityId = client.entityId;

    // Set the initial state of the Entity (e.g. spawn point).
    const spawnPoints = [4, 6];
    entity.x = spawnPoints[client.entityId];
  }

  setUpdateRate(hz) {
    this.updateRate = hz;
    clearInterval(this.updateInterval);
    this.updateInterval = setInterval(() => {
      this.update();
    }, 1000 / this.updateRate);
  }

  update() {
    this.processInputs();
    this.sendWorldState();
    renderWorld(this.canvas, this.entities);
  }

  // Check whether this input seems to be valid (e.g. "make sense") according
  // to the physical rules of the World.
  validateInput(input) {
    if (Math.abs(input.pressTime) > 1 / 40) {
      return false;
    }
    return true;
  }

  processInputs() {
    // Process all pending messages from clients.
    while (true) {
      const message = this.network.receive();
      if (!message) {
        break;
      }

      // Update the state of the entity, based on its input.
      // We just ignore inputs that don't look valid; this is what prevents clients from cheating.
      if (this.validateInput(message)) {
        const id = message.entityId;
        this.entities[id].applyInput(message);
        this.lastProcessedInput[id] = message.inputSequenceNumber;
      }
    }

    // Show some info.
    const infos = ["Last acknowledged input:"];
    for (let i = 0; i < this.clients.length; i++) {
      infos.push(`Player ${i}: #${this.lastProcessedInput[i] || 0}`);
    }
    this.status.textContent = infos.join("  ");
  }

  // Send the world state to all the connected clients.
  sendWorldState() {
    // Gather the state of the world. In a real app, state could be filtered to
    // avoid leaking data, e.g. position of invisible enemies.
    const worldState = [];
    const numClients = this.clients.length;
    for (let i = 0; i < numClients; i++) {
      const entity = this.entities[i];
      worldState.push({
        entityId: entity.entityId,
        position: entity.x,
        lastProcessedInput: this.lastProcessedInput[i]
      });
    }

    // Broadcast the state to all the clients.
    for (let i = 0; i < numClients; i++) {
      const client = this.clients[i];
      client.network.send(client.lag, worldState);
    }
  }
}

// =============================================================================
//  Helpers.
// =============================================================================

// Render all the entities in the given canvas.
function renderWorld(canvas, entities) {
  // Clear the canvas.
  canvas.width = canvas.width;

  const colors = ["blue", "red"];
  for (let entityId in entities) {
    const entity = entities[entityId];
    // Compute size and position.
    const radius = (canvas.height * 0.9) / 2;
    const x = (entity.x / 10.0) * canvas.width;

    // Draw the entity.
    const ctx = canvas.getContext("2d");
    ctx.beginPath();
    ctx.arc(x, canvas.height / 2, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = colors[entityId];
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "dark" + colors[entityId];
    ctx.stroke();
  }
}

const $ = id => document.getElementById(id);

// =============================================================================
//  Get everything up and running.
// =============================================================================

// World update rate of the Server.
const serverFps = 4;

// Update simulation parameters from UI.
function updateParameters() {
  updatePlayerParameters(player1, "player1");
  updatePlayerParameters(player2, "player2");
  server.setUpdateRate(updateNumberFromUI(server.updateRate, "server_fps"));
  return true;
}

function updatePlayerParameters(client, prefix) {
  client.lag = updateNumberFromUI(player1.lag, prefix + "_lag");

  // Checkbox.
  let cbPrediction = $(prefix + "_prediction");
  let cbReconciliation = $(prefix + "_reconciliation");

  // Client Side Prediction disabled => disable Server Reconciliation.
  if (client.clientSidePrediction && !cbPrediction.checked) {
    cbReconciliation.checked = false;
  }

  // Server Reconciliation enabeld => enable Client Side Prediction.
  if (!client.serverReconciliation && cbReconciliation.checked) {
    cbPrediction.checked = true;
  }

  client.clientSidePrediction = cbPrediction.checked;
  client.serverReconciliation = cbPrediction.checked;

  client.entityInterpolation = $(prefix + "_interpolation").checked;
}

function updateNumberFromUI(oldValue, elementId) {
  const input = $(elementId);
  let newValue = parseInt(input.value, 10);
  if (isNaN(newValue)) {
    newValue = oldValue;
  }
  input.value = newValue;
  return newValue;
}

// When the player presses the arrow keys, set the corresponding flag in the client.
function keyHandler(e) {
  e = e || window.event;
  if (e.keyCode == 39) {
    player1.keyRight = e.type == "keydown";
  } else if (e.keyCode == 37) {
    player1.keyLeft = e.type == "keydown";
  } else if (e.key == "d") {
    player2.keyRight = e.type == "keydown";
  } else if (e.key == "a") {
    player2.keyLeft = e.type == "keydown";
  } else {
    console.log(e);
  }
}

document.body.onkeydown = keyHandler;
document.body.onkeyup = keyHandler;

// Setup a server, the player's client, and another player.
const server = new Server($("server_canvas"), $("server_status"));
const player1 = new Client($("player1_canvas"), $("player1_status"));
const player2 = new Client($("player2_canvas"), $("player2_status"));

// Connect the clients to the server.
server.connect(player1);
server.connect(player2);

// Read initial parameters from the UI.
updateParameters();
