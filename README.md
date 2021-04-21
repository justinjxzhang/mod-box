# mod-box 
This project aims to provide a physical interface for the LV2 host by MOD Devices.

![rough photo](https://raw.githubusercontent.com/justinjxzhang/mod-box/main/mod-box-rough.jpg)

Built for the Raspberry Pi in node, this connects to the MOD suite via the websocket exposed by mod-ui. 

This also relies on the [modified oled-js library](https://github.com/justinjxzhang/oled-js)

Slight modificiations to mod-ui are needed in order to allow for CORS with the websocket handler and the EffectResource REST endpoint, patch is in mod-cors.patch

To run:
* install dependencies using `npm install`
* pull the aforementioned oled-js library into the same parent folder as this project
* run with 'sudo npx ts-node-dev main.ts' *Running as root required in order to access the Raspberry Pi's I2C*
