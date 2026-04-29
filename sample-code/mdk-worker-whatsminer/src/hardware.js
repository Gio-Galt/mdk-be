/**
 * Hardware Simulator specifically for a MicroBT Whatsminer.
 * In a real implementation, this would use native fetch to call the miner's REST API
 * or use a socket to talk to CGMiner API port (usually 4028).
 */
export default class HardwareService {
  constructor(deviceId, ip) {
    this.deviceId = deviceId;
    this.ip = ip;
    
    // Internal simulated state
    this.state = {
      hashrate: 110.5, // TH/s
      powerLimit: 3200, // W
      powerDraw: 3100, // W
      tempIn: 25,
      tempOut: 78,
      fanIn: 4500,
      fanOut: 4600,
      status: 'Normal'
    };
  }

  async fetchRawTelemetry() {
    // Simulate network delay to device
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Add slight randomization to simulate live data
    const jitter = () => (Math.random() - 0.5) * 2;
    
    return {
      "STATUS": [{ "STATUS": "S", "When": Date.now(), "Msg": "Summary" }],
      "SUMMARY": [{
        "GHS 5s": (this.state.hashrate * 1000) + (jitter() * 500),
        "GHS av": this.state.hashrate * 1000,
        "Power": this.state.powerDraw + (jitter() * 20),
        "Temp In": this.state.tempIn + (jitter() * 0.5),
        "Temp Out": this.state.tempOut + (jitter() * 1.5),
        "Fan In": this.state.fanIn + (jitter() * 50),
        "Fan Out": this.state.fanOut + (jitter() * 50)
      }]
    };
  }

  async fetchHardwareHealth() {
    // Return standard whatsminer mock health object
    return {
      status: this.state.status,
      errors: [] // Standard error codes would go here e.g. ["E_TEMP_HIGH"]
    };
  }

  async executeCommand(commandName, params) {
    switch (commandName) {
      case 'reboot':
        console.log(`[Hardware: ${this.ip}] Init reboot...`);
        this.state.hashrate = 0;
        this.state.powerDraw = 50;
        this.state.status = 'Booting';
        return { success: true };
      
      case 'setPowerLimit':
        const { limit_watts } = params;
        if (limit_watts < 2000) throw new Error("Power limit too low");
        console.log(`[Hardware: ${this.ip}] Setting Power Limit to ${limit_watts}W`);
        this.state.powerLimit = limit_watts;
        this.state.powerDraw = limit_watts - 100; // rough estimation
        return { success: true };

      default:
        throw new Error(`Command ${commandName} not supported in hardware layer`);
    }
  }
}
