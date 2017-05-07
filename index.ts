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
 * Interface for a Homebridge Plugin, minus the constructor because
 * TypeScript is weird and doesn't let you do that. Constructor signature:
 * constructor(api: HomebridgeAPI): void
 * 
 * @interface HomebridgePlugin
 */
interface HomebridgePlugin {
    getServices(): any[];
}

/**
 * Interface for the homebridge API, defined to make Typescript happy.
 * 
 * @interface HomebridgeAPI
 */
interface HomebridgeAPI {
    hap: any;
    registerAccessory(packageName: String, pluginName: String, 
        constructor: (log: HBLogFunc, config: RPGConfig) => void): void;
}

/**
 * Config json structure for my plugin.
 * 
 * @interface RPGConfig
 */
interface RPGConfig {
    name: String;
    doorPin: number;
    timeToOpen: number;
    buttonHoldTime: number,
}

/**
 * Entry point for the plugin.
 */
export default (api: HomebridgeAPI) => {
    new GarageDoorAccessory(api);
}

/**
 * Class that represents a Homebridge accessory for controlling
 * a simple garage door opener. Handles all states of a typical
 * garage door opener.
 * 
 * @class GarageDoorAccessory
 * @implements {HomebridgePlugin}
 */
class GarageDoorAccessory implements HomebridgePlugin {
    readonly PKG_NAME: String = 'homebridge-rpi-garagedoor';
    readonly NAME: String = 'RPIGarageDoor';
    readonly MANUFACTURER: String = 'Homebridge';
    readonly MODEL: String = 'Garage Opener';
    readonly SERIAL: String = '8675309';
    readonly DEFAULT_DOOR_PIN = 12;
    readonly DEFAULT_TIME_OPEN = 10;
    readonly DEFAULT_BTN_HOLD_TIME = 0.1;
    readonly MS_IN_S = 1000;

    private api: HomebridgeAPI; // the homebridge api object reference
    private config: RPGConfig; // parsed configuration from config.json
    private log: HBLogFunc; // the wrapped logging function homebridge gives us
    private openerService: any; // the GarageDoorOpener service object
    private timer: NodeJS.Timer; // a timer for waiting on the door to open/close
    private services: any[]; // the services associated with this plugin

    /**
     * Creates an instance of GarageDoorAccessory and registers the plugin.
     * @param {HomebridgeAPI} homebridge the homebridge api object passed into
     * the plugin
     * 
     * @memberof GarageDoorAccessory
     */
    constructor(api: HomebridgeAPI) {
        this.api = api;

        this.api.registerAccessory(this.PKG_NAME, this.NAME, this.initialize);
    }

    /**
     * Sets up the plugin and all of its services.
     * @param {HBLogFunc} log the plugin's logger function
     * @param {RPGConfig} config the configuration from config.json
     * 
     * @memberof GarageDoorAccessory
     */
    initialize(log: HBLogFunc, config: RPGConfig) {
        this.log = log;

        // parse config json
        this.config.name = config.name;
        this.config.doorPin = config.doorPin || this.DEFAULT_DOOR_PIN;
        this.config.timeToOpen = config.timeToOpen || this.DEFAULT_TIME_OPEN;
        this.config.buttonHoldTime = config.buttonHoldTime || this.DEFAULT_BTN_HOLD_TIME;
        log("initialized with pin [" + this.config.doorPin + "], tOpen ["
            + this.config.timeToOpen + "] buttonTime [" 
            + this.config.buttonHoldTime + "]");

        // bad way of accessing hap-nodejs API but required by homebridge
        let Service = this.api.hap.Service;
        let Characteristic = this.api.hap.Characteristic;
        
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
        RPIO.open(this.config.doorPin, RPIO.OUTPUT, RPIO.LOW);

        // more hackish hap-nodejs api access
        let CurrentDoorState = this.api.hap.Characteristic.CurrentDoorState;
        let TargetDoorState = this.api.hap.Characteristic.TargetDoorState;

        // set initial door state
        service.setCharacteristic(CurrentDoorState, CurrentDoorState.CLOSED);
        service.setCharacteristic(TargetDoorState, TargetDoorState.CLOSED);

        // setup service callback for monitoring state
        service.getCharacteristic(TargetDoorState).on('set', (newValue: any, callback: any) => {
            // first get the current state
            let currentState = service.getCharacteristic(CurrentDoorState).value;
            
            switch(newValue) {
                // TARGET = OPENED
                case TargetDoorState.OPEN:
                    this.log("Target is OPENING");

                    if (currentState == CurrentDoorState.CLOSED) {
                        // start opening the door
                        this.toggleDoor();
                        this.setState(CurrentDoorState.OPENING);
                        this.log("Door OPENING");

                        // set a timer to set the door as open when it is done
                        this.timer = global.setTimeout(() => {
                            // make sure door is still opening
                            if (this.getState() == CurrentDoorState.OPENING) {
                                this.setState(CurrentDoorState.OPEN);
                            }
                        }, this.config.timeToOpen * this.MS_IN_S);
                    }
                    else if (currentState == CurrentDoorState.OPEN) {
                        // don't do anything because it's already open
                        this.log("Door already OPEN");
                    }
                    else {
                        // if door is closing or opening then stop the door
                        this.toggleDoor();
                        this.setState(CurrentDoorState.STOPPED);
                        this.log("Door STOPPED");
                    }
                    break;
                
                // TARGET = CLOSED
                case TargetDoorState.CLOSED:
                    this.log("Target is CLOSING");

                    if (currentState == CurrentDoorState.OPEN) {
                        // start closing the door
                        this.toggleDoor();
                        this.setState(CurrentDoorState.CLOSING);
                        this.log("Door CLOSING");

                        // set a timer to set the door as closed when it is done
                        this.timer = global.setTimeout(() => {
                            // make sure door is still closing
                            if (this.getState() == CurrentDoorState.CLOSING) {
                                this.setState(CurrentDoorState.CLOSED);
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
    }
    
    /**
     * Helper function to set the CurrentDoorState.
     * @param {*} state the CurrentDoorState to set on the service
     * 
     * @memberof GarageDoorAccessory
     */
    setState(state: any) {
        let CurrentDoorState = this.api.hap.Characteristic.CurrentDoorState;

        this.openerService.setCharacteristic(CurrentDoorState, state);
    }

    /**
     * Helper function to get the CurrentDoorState.
     * @returns {*} the CurrentDoorState of the service
     * 
     * @memberof GarageDoorAccessory
     */
    getState(): any {
        let CurrentDoorState = this.api.hap.Characteristic.CurrentDoorState;

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
        RPIO.write(this.config.doorPin, RPIO.HIGH);
        RPIO.sleep(this.config.buttonHoldTime);
        RPIO.write(this.config.doorPin, RPIO.LOW);
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