/**
 * homebridge-rpi-garagedoor
 * A simple Raspberry Pi Garage Door Opener/Closer Plugin for Homebridge.
 * Cory Mayer
 * 
 * Note: I hackish-ly created interfaces for homebridge classes because I didn't
 * have time to make type definitions for TypeScript. Sorry.
 */
import * as RPIO from 'rpio';

/**
 * The Homebridge log wrapper function.
 */
type HBLogFunc = (msg: String) => void;

/**
 * Base class that represents a plugin for Homebridge.
 * 
 * @abstract
 * @class HomebridgePlugin
 */
abstract class HomebridgePlugin {
    public static api: any; // the homebridge api object reference

    constructor(log: HBLogFunc, config: any[]) {
        // IMPLEMENTME
    }

    abstract getServices(): any[];
}

/**
 * Config json structure for my plugin.
 * 
 * @class RPGConfig
 */
class RPGConfig {
    name: String;
    doorPin: number;
    timeToOpen: number;
    buttonHoldTime: number;
}

/**
 * Entry point for the plugin.
 */
module.exports = (api: any) => {
    HomebridgePlugin.api = api;

    api.registerAccessory('homebridge-rpi-garagedoor', 'RPIGarageDoor', GarageDoorAccessory);
}

/**
 * Class that represents a Homebridge accessory for controlling
 * a simple garage door opener. Handles all states of a typical
 * garage door opener.
 * 
 * @class GarageDoorAccessory
 * @implements {HomebridgePlugin}
 */
class GarageDoorAccessory extends HomebridgePlugin {
    readonly MANUFACTURER: String = 'Homebridge';
    readonly MODEL: String = 'Garage Opener';
    readonly SERIAL: String = '8675309';
    readonly DEFAULT_DOOR_PIN = 12;
    readonly DEFAULT_TIME_OPEN = 10;
    readonly DEFAULT_BTN_HOLD_TIME = 0.1;
    readonly MS_IN_S = 1000;

    private config: RPGConfig; // parsed configuration from config.json
    private log: HBLogFunc; // the wrapped logging function homebridge gives us
    private openerService: any; // the GarageDoorOpener service object
    private timer: NodeJS.Timer; // a timer for waiting on the door to open/close
    private services: any[]; // the services associated with this plugin

    /**
     * Sets up the plugin and all of its services.
     * @param {HBLogFunc} log the plugin's logger function
     * @param {RPGConfig} config the configuration from config.json
     * 
     * @memberof GarageDoorAccessory
     */
    constructor(log: HBLogFunc, config: any[]) {
        super(log, config);
        this.log = log;

        // parse config json
        this.config = new RPGConfig();
        this.config.name = config['name'];
        this.config.doorPin = config['doorPin'] || this.DEFAULT_DOOR_PIN;
        this.config.timeToOpen = config['timeToOpen'] || this.DEFAULT_TIME_OPEN;
        this.config.buttonHoldTime = config['buttonHoldTime'] || this.DEFAULT_BTN_HOLD_TIME;
        log("initialized with pin [" + this.config.doorPin + "], tOpen ["
            + this.config.timeToOpen + "] buttonTime [" 
            + this.config.buttonHoldTime + "]");

        // bad way of accessing hap-nodejs API but required by homebridge
        let Service = HomebridgePlugin.api.hap.Service;
        let Characteristic = HomebridgePlugin.api.hap.Characteristic;
        
        this.services = []
        // create opener service
        this.openerService = new Service.GarageDoorOpener(this.config.name, 
                                                         this.config.name);
        this.configOpenerService();
        this.services.push(this.openerService);

        // create accessory service
        this.services.push(new Service.AccessoryInformation()
            .setCharacteristic(Characteristic.Manufacturer, this.MANUFACTURER)
            .setCharacteristic(Characteristic.Model, this.MODEL)
            .setCharacteristic(Characteristic.SerialNumber, this.SERIAL));
    }

    /**
     * Main logic for the plugin that configures what happens
     * when various callbacks occur on the service.
     * 
     * @memberof GarageDoorAccessory
     */
    configOpenerService() {
        let service = this.openerService;

        // create the rpio pin for door control, set pulldown resistor
        if (process.env.DEBUG != '*') {
            RPIO.open(this.config.doorPin, RPIO.OUTPUT, RPIO.LOW);
        }
        
        // more hackish hap-nodejs api access
        let CurrentDoorState = HomebridgePlugin.api.hap.Characteristic.CurrentDoorState;
        let TargetDoorState = HomebridgePlugin.api.hap.Characteristic.TargetDoorState;

        // set initial door state
        service.setCharacteristic(CurrentDoorState, CurrentDoorState.CLOSED);
        service.setCharacteristic(TargetDoorState, TargetDoorState.CLOSED);

        // setup service callback for monitoring state
        service.getCharacteristic(TargetDoorState).on('get', (callback: any) => {
            let curValue = service.getCharacteristic(TargetDoorState).value;

            this.log("GET TARGET: " + curValue)

            callback(null, curValue);
        });

        service.getCharacteristic(TargetDoorState).on('set', (newValue: any, callback: any) => {
            // first get the current state
            let currentState = service.getCharacteristic(CurrentDoorState).value;
            
            switch (newValue) {
                // TARGET = OPENED
                case TargetDoorState.OPEN:
                    this.log("Target is OPENING");

                    if (currentState == CurrentDoorState.CLOSED ||
                        currentState == CurrentDoorState.CLOSING) {
                        // start opening the door
                        this.toggleDoor();
                        this.setState(CurrentDoorState.OPENING);
                        this.log("Door OPENING");

                        // set a timer to set the door as open when it is done
                        this.timer = global.setTimeout(() => {
                            // make sure door is still opening
                            if (this.getState() == CurrentDoorState.OPENING) {
                                this.setState(CurrentDoorState.OPEN);
                                this.log("Door is OPEN");
                            }
                        }, this.config.timeToOpen * this.MS_IN_S);
                    }
                    else if (currentState == CurrentDoorState.OPEN) {
                        // don't do anything because it's already open
                        this.log("Door already OPEN");
                    }
                    else if (currentState == CurrentDoorState.STOPPED) {
                        // If the door is opening, we stop it, and resume from
                        // a stop, iOS insists the next direction should be open.
                        // Since we can't override this, we just have to do a 
                        // noop here to match the actual door operation.
                        // Users will have to tap twice to resume.
                    }
                    else {
                        // if door is opening then stop the door
                        this.toggleDoor();
                        this.setState(CurrentDoorState.STOPPED);
                        this.log("Door STOPPED");
                    }
                    break;
                
                // TARGET = CLOSED
                case TargetDoorState.CLOSED:
                    this.log("Target is CLOSING");

                    if (currentState == CurrentDoorState.OPEN ||
                        currentState == CurrentDoorState.STOPPED) {
                        // start closing the door
                        this.toggleDoor();
                        this.setState(CurrentDoorState.CLOSING);
                        this.log("Door CLOSING");

                        // set a timer to set the door as closed when it is done
                        this.timer = global.setTimeout(() => {
                            // make sure door is still closing
                            if (this.getState() == CurrentDoorState.CLOSING) {
                                this.setState(CurrentDoorState.CLOSED);
                                this.log("Door is CLOSED");
                            }
                        }, this.config.timeToOpen * this.MS_IN_S);
                    }
                    else if (currentState == CurrentDoorState.CLOSED) {
                        // don't do anything, already closed
                        this.log("Door is already CLOSED");
                    }
                    else {
                        // if door is closing or opening then stop the door
                        this.toggleDoor();
                        this.setState(CurrentDoorState.STOPPED);
                        this.log("Door STOPPED");
                    }
                    break;
            }

            // call the callback because the hap-nodejs documentation says so
            callback();
        });

        // setup service to send state back to device
        service.getCharacteristic(CurrentDoorState).on('get', (callback: any) => {
            this.log("GET STATE: " + this.getState());

            callback(null, this.getState());
        });
    }
    
    /**
     * Helper function to set the CurrentDoorState.
     * @param {*} state the CurrentDoorState to set on the service
     * 
     * @memberof GarageDoorAccessory
     */
    setState(state: any) {
        let CurrentDoorState = HomebridgePlugin.api.hap.Characteristic.CurrentDoorState;

        this.openerService.setCharacteristic(CurrentDoorState, state);
    }

    setTargetState(state: any) {
        let TargetDoorState = HomebridgePlugin.api.hap.Characteristic.TargetDoorState;

        this.openerService.setCharacteristic(TargetDoorState, state);
    }

    /**
     * Helper function to get the CurrentDoorState.
     * @returns {*} the CurrentDoorState of the service
     * 
     * @memberof GarageDoorAccessory
     */
    getState(): any {
        let CurrentDoorState = HomebridgePlugin.api.hap.Characteristic.CurrentDoorState;

        return this.openerService.getCharacteristic(CurrentDoorState).value;
    }

    /**
     * Simulates pressing the garage door push button by turning
     * on the transistor that bridges the push button terminals
     * for a breif time.
     * 
     * @memberof GarageDoorAccessory
     */
    toggleDoor() {
        if (process.env.DEBUG == '*') {
            this.log("TOGGLE");
        }
        else {
            RPIO.write(this.config.doorPin, RPIO.HIGH);
            RPIO.sleep(this.config.buttonHoldTime);
            RPIO.write(this.config.doorPin, RPIO.LOW);
        }
        
    }

    /**
     * Gets all of the services associated with this plugin.
     * @returns {any[]} an array of Services
     * 
     * @memberof GarageDoorAccessory
     */
    getServices(): any[] {
        return this.services;
    }
}
