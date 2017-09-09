# homebridge-rpi-garagedoor
A Raspberry Pi LiftMaster garage door opener/closer plugin for Homebridge using
GPIO pins. Designed for a simple hardware setup without any feedback. Supports
opening/closing states via a time estimate, and stopping the door while opening
and closing.

## Usage
Add a transistor that shorts the opener push button wire to ground on the 
LiftMaster box when you send a logic high to the gate (doorPin in config.json). 
See sample config.json for configuration.