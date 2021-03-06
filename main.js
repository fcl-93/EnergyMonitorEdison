var express = require('express');
var http = require('http');
var app = express();
app.use(express.static(__dirname+"/public"));
app.use(express.static(__dirname+"/views"));
//Listen on port 1337
var server = app.listen(1337);
var io = require('socket.io').listen(server);

var mraa = require('mraa'); //require mraa
console.log('MRAA Version: ' + mraa.getVersion()); //write the mraa version to the Intel XDK console

//Gets sparkfunAdc library to work with the ADC block (https://github.com/flowthings/sparkfunAdc)
var sparkfunAdc = require('sparkfunAdc');

//Analog 0 is used by default with range range between -4.096V and 4.094V, and step size is 2mV.
//See https://learn.sparkfun.com/tutorials/sparkfun-blocks-for-intel-edison---adc for more information about available step ranges
var a0_4v = new sparkfunAdc.Adc({
  debug: false,
});

//An example on how to set another analog port (A1 in this case) and a diferent step size
/*var a1_2v = new sparkfunAdc.Adc({
  inMux: sparkfunAdc.IN_MUX_AIN1_GND,
  pga: sparkfunAdc.PGA_2_048V
});*/

//If using edison kit use this to set A0 to read the current instead of a0_4V
//var analogPin0 = new mraa.Aio(0);

//Use mraa 37 when using DFRobot (DFR338) shield or 13 when using edison kit
var Relay = new mraa.Gpio(37);
Relay.dir(mraa.DIR_OUT); //set the gpio direction to output

//Go to /node_app_slot/node_modules on the edison and install jsonfile using: npm install --save jsonfile
//More information about jsonfile at https://www.npmjs.com/package/jsonfile
var jsonfile = require('jsonfile');
//Some of the settings are saved on json file
var settingsJSON = '/node_app_slot/Settings.json';
var settingsBackUp = '/node_app_slot/SettingsBackup.json';
var databaseConfigPath = "/node_app_slot/databaseConfig.json";
var settingsValues;

//Database config files loading.
try{
    var databaseConfig = jsonfile.readFileSync(databaseConfigPath);
}
catch(error){
    console.log("Unale to read database config file." + error);
}

//Sometimes when writing to the settings file it would go blank. These lines of code will catch an error if that happens and
//load the original default values for the MainsVoltage (230V) and relayState (true)
try {
    settingsValues = jsonfile.readFileSync(settingsJSON);
}
catch(e){
    settingsValues = jsonfile.readFileSync(settingsBackUp);
}

//Gets previous MainsVoltage value from settings file
var MainsVoltage = settingsValues.MainsVoltage;
//Gets previous relayState value from settings file
var relayState = settingsValues.relayState;

//Assigns the read values from the config file to variables.
var databaseHostIp = databaseConfig.databaseIp;
var databasePort = databaseConfig.port;
var databaseAuthUrl = databaseConfig.authUrl;


//console.log(MainsVoltage);
console.log(relayState);

//Turns relay on/off according to relayState value at beginning
Relay.write(relayState?1:0);

//100mV/A sensibility with ASC712-20 but since i'm using sparkfunADC block the max voltage is 3.3 V
//sensibility = (100mV/A * 3.3V)/5V = 66 mV/A
var sensibility = 66;

var AmpRMS = 0;
var Power = 0;

//Using sparkfunADC block this is the zero value on average. Use Calibrate button to get value if using another sensor or another ADC
//var adcZero = 818;
//console.log(adcZero);
var adcZero = determineADCzero();

var sampleTime = 0.1;
var samples = 500;
var sampleInterval = sampleTime/samples;

var powerTreshold = 25;
var timeTreshold = 5000; // In miliseconds => 10s

//The time when we start the plug
var previousEventTime = Date.now();
//If using edison kit use these
/*var pwmRed = new mraa.Pwm(3);//red
var pwmGreen = new mraa.Pwm(5);//green
var pwmBlue = new mraa.Pwm(9);//blue*/

//If using DFRobot shield use these (they map to PWM 3, 5 and 9)
var pwmRed = new mraa.Pwm(20);//red
var pwmGreen = new mraa.Pwm(21);//green
var pwmBlue = new mraa.Pwm(14);//blue

pwmRed.enable(true);//red
pwmGreen.enable(true);//green
pwmBlue.enable(true);//blue

//LED's start at green
var stateled='green';
var pstateled='green';
console.log("#1")
var redIncrement = 0;
var greenIncrement = 0;
var gradient = 0.10;

//Digital 11 if using edison kit
var relay_button = new mraa.Gpio(38);
relay_button.dir(mraa.DIR_IN);

//Digital 12 if using edison kit
//LED turns on/off if plug is active/inactive
var led_plug_ON_OFF = new mraa.Gpio(50);
led_plug_ON_OFF.dir(mraa.DIR_OUT);
led_plug_ON_OFF.write(relayState?1:0);

//Will be used for the physical button to turn relay on/off
var last_state = 0;
var button = 0;

var storePowerSamples = [0,0,0,0];    //Default Values to median calc.  -- No Data
//var copyStorePowerSamples =[0,0]; //Default Values fro Backups calc. -- No Data
//The median is used to detect an event
var  storeAveragePowerBegin = null;
var storeAveragePowerEnd = null;


//If a new client connects runs the callback function
io.sockets.on('connection', function (socket) {
    console.log("#2")
    //Sends the value of the !relayState to all clients on connect
    io.emit('control_relay', {value: !relayState});
    //Sends the value of the MainsVoltage selected to all clients on connect
    io.emit('updateVoltageOption', MainsVoltage);

    //Runs this function every 2 seconds
    setInterval(function () {
        //console.log('state '+relayState);
        //console.log(Date.now());
        if (!relayState) {
            //Sends the power and current consumed to the client
            socket.emit( 'power' , JSON.stringify({'power':0,'current':0}));
            stateled='green';
        }else{
            //Sends the power and current consumed to the client
            var postData = getPower();
            socket.emit( 'power' , JSON.stringify(postData));
            storePowerSamples.push(postData.power);

            if (storePowerSamples.length >= 5)
            {
                //Calculates the average when the average when the buffer is full
                storeAveragePowerBegin = (storePowerSamples[0] + storePowerSamples[1])/2;
                storeAveragePowerEnd = (storePowerSamples[3] + storePowerSamples[4])/2;
                var averageDiference = storeAveragePowerBegin - storeAveragePowerEnd; // Module difference between the averages
                //console.log(storePowerSamples);

                //console.log("The diffrence is: " + (Date.now() - previousEventTime) );
                if(Date.now() - previousEventTime >=  timeTreshold){ //Block Event Detection
                    if( Math.abs(averageDiference) >= powerTreshold){ //And event happaned.

                        //Detects the triggers Up or Down
                        if(averageDiference < 0){
                                //console.log(" ### Turned a new device on ###");
                                stateValue = "ON";
                                previousEventTime = Date.now();
                        }
                        else if(averageDiference >= 0){
                                //console.log(" ### Turned a device off ###");
                                stateValue = "OFF";
                                previousEventTime = Date.now();
                        }
                            var postEventData = {
                                type: stateValue,
                                timestamp: Date.now()
                            };
                            sendEvents(postEventData);
                    }else{
                        //console.log("No Event Detected");   //No event Detection
                    }

               }
                  storePowerSamples.shift();      // Remove one of the items it doesn't matter the order.
            }

            sendMeasuredPoints(postData);


            //Updates the value of the !relayState on all clients
            io.emit('control_relay', {value: !relayState});
            //Updates the value of the MainsVoltage selected on all clients
            io.emit('updateVoltageOption', MainsVoltage);

            //jsonfile.writeFileSync(settingsJSON, {"MainsVoltage":MainsVoltage, "relayState":relayState});
        }
    }, 1000);

    //Listens for a msg sent from client with keyword 'control_relay'.
    //This is called when the 'Turn on plug/Turn off plug' button is pressed
    socket.on('control_relay', function(msg) {
        msg.value = relayState;
        //Updates the value of the MainsVoltage selected on all clients
        io.emit('control_relay', msg);
        //Inverts the relayState
        relayState = !relayState;
        Relay.write(relayState?1:0);
        //Turns LED on/off
        led_plug_ON_OFF.write(relayState?1:0);
        //Updates settings file with new relayState value
        jsonfile.writeFileSync(settingsJSON, {"MainsVoltage":MainsVoltage, "relayState":relayState, "database_ip":databaseHostIp});
    });

    //Listens for a msg sent from client with keyword 'voltageOption'.
    //This is called when a new mains voltage is selected
    socket.on('voltageOption', function(VrmsOption){
        MainsVoltage = VrmsOption;
        //Updates the value of the MainsVoltage selected on all clients
        io.emit('updateVoltageOption', MainsVoltage);
        //Updates settings file with new MainsVoltage value
        jsonfile.writeFileSync(settingsJSON, {"MainsVoltage":MainsVoltage, "relayState":relayState, "database_ip":databaseHostIp});
    });

    //Listens for a msg sent from client with keyword 'calibrate'.
    //This is called when the Calibrate button is pressed
    socket.on('calibrate', function(){
        //Calls determineADCzero() to get the zero value
        adcZero = determineADCzero();
        socket.emit('calibration_response');
    });
});

//Send On and Off events when a device is plugged and the signal changes
function sendEvents(postData){
    var options = {
    auth: databaseAuthUrl,
    host: databaseHostIp,
    port: databasePort,
    path: '/api/json/plugs_events',
    method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    };
    var post_req = http.request(options, function(res) {
        res.setEncoding('utf8');
    });
    post_req.on('error', function(err) {
        console.log("Cannot connect to server.");
        //console.log(err);
    });

    post_req.write(JSON.stringify(postData));
    post_req.end();
    //console.log("Sending Event Values");

}
//Send the data to the server (Measured Points)
function sendMeasuredPoints(postData){
    var options = {
        auth: databaseAuthUrl,
        host: databaseHostIp,
        port: databasePort,
        path: '/api/json/continuous_measuring',
        method: 'POST',
        headers: {
                'Content-Type': 'application/json'
            }
    };
    var post_req = http.request(options, function(res) {
        res.setEncoding('utf8');
    });
    post_req.on('error', function(err) {
        console.log("Cannot connect to server.");
        //console.log(err);
    })
    post_req.write(JSON.stringify(postData));
    post_req.end();
    //console.log("Sending Values");
}

//This function is called every 100 ms to change the LED's colours
//It can fade from green to red or vice versa
setInterval(function () {

    if (stateled==='red'){
        if (pstateled==='red'){
            pwmRed.write(1.0000);//r
            pwmGreen.write(0.0000);//g
            redIncrement=1.0000;
            greenIncrement=0.0000;
        }
        else if (pstateled==='yellow'){
            greenIncrement=greenIncrement-gradient;
            pwmRed.write(1.0000);
            pwmGreen.write(greenIncrement);
            if (greenIncrement<=0.0000 && redIncrement>=1.0000){
                pstateled='red';
            }

        }
        else {
            redIncrement=redIncrement+gradient;
            greenIncrement=greenIncrement-gradient;
            pwmRed.write(redIncrement);
            pwmGreen.write(greenIncrement);
            if (greenIncrement<=0.0000 && redIncrement>=1.0000){
                pstateled='red';
            }

        }

    }
    if (stateled==='yellow'){
        if (pstateled==='yellow'){
                pwmRed.write(1.0000);
                pwmGreen.write(1.0000);
               // pwmBlue.write(0.0000);
            redIncrement=1.0000;
            greenIncrement=1.0000;
        }
        else if (pstateled==='red'){
            greenIncrement=greenIncrement+gradient;
            pwmRed.write(1.0000);
            pwmGreen.write(greenIncrement);
            if (greenIncrement>=1.0000 && redIncrement>=1.0000){
                pstateled='yellow';
            }
        }
        else {
            redIncrement=redIncrement+gradient;
            pwmRed.write(redIncrement);
            pwmGreen.write(1.0000);
            if (greenIncrement>=1.0000 && redIncrement>=1.0000){
                pstateled='yellow';
            }

        }


        }

    if (stateled==='green'){
     if (pstateled==='green'){
                pwmRed.write(0.0000);
               // pwmGreen.write(1.0000);
              //  pwmBlue.write(0.000);
                redIncrement=0.0000;
                greenIncrement=1.0000;
     }

       else if(pstateled==='red') {
            redIncrement=redIncrement-gradient;
            greenIncrement=greenIncrement+gradient;
            pwmRed.write(redIncrement);
            pwmGreen.write(greenIncrement);
            if (greenIncrement>=1.0000 && redIncrement<=0.0000){
                pstateled='green';
            }
       }
        else {
            redIncrement=redIncrement-gradient;
            pwmRed.write(redIncrement);
            pwmGreen.write(1.0000);
            if (greenIncrement>=1.0000 && redIncrement<=0.0000){
                pstateled='green';
            }


        }


    }

	}, 100);

//Checks if physical button to control the relay was pressed every 300 ms
setInterval(function() {
    button = relay_button.read();
    if(button != last_state){
       if(button === 1){
            relayState = !relayState;
            Relay.write(relayState?1:0);
            led_plug_ON_OFF.write(relayState?1:0);
       }
    }
    last_state = button;
},300);

//This function reads current and calculates power consumed
function getPower() {
    var result = 0;
    var readValue = 0;
    var countSamples = 0;

    var startTime = Date.now()-sampleInterval;
    var storeSamples = [];
    //console.log('Date before while: ' + Date.now());

    while(countSamples < samples){
      //To give some time before reading again
      if((Date.now()-startTime) >= sampleInterval){
        //Centers read value at zero
        readValue = a0_4v.adcRead() - adcZero;
        storeSamples.push(readValue);
        //Squares all values and sums them
        result += (readValue * readValue);
        countSamples++;
        startTime += sampleInterval;
      }
    }

    //console.log(storeSamples);
    var sum = 0
    for (var i = 0; i < storeSamples.length; i++) {
        sum += storeSamples[i];
    }
    //console.log(sum/storeSamples.length);
    //console.log('Date after while: ' + Date.now());

    //Calculates RMS current. 3300 = 3.3V/mV. 1650 is the max ADC count i can get with 3.3V
    AmpRMS = (Math.sqrt(result/countSamples))*3300/(sensibility*1650);

    //If using a ADC at 5V and 8 bits
    //AmpRMS = (Math.sqrt(result/countSamples))*5000/(sensibility*1024);

    //console.log("Irms: ", AmpRMS);

   //Calculates Power as an integer
   Power = ~~(AmpRMS * MainsVoltage);

   //Ignores some of the noise
   if(AmpRMS <= 0.10){
       Power = 0;
       AmpRMS = 0;
   }

    //Gauge display will become red when power is above 1000 W
    if (Power>=1000){
        stateled='red';
    }

    //Gauge display will become yellow when power is between 300 W and 1000 W
    else if (Power>300 && Power<1000){
        stateled='yellow';
    }

    //Gauge display will become red when power is below 300 W
    else{
        stateled='green';
    }

    //So that the needle on display gauge doesn't cross the max displayed value
    if(Power >= 2000){
         Power = 2000;
    }

   return {'power':Power, 'current':AmpRMS.toFixed(2), timestamp: Date.now()};
}

//This function calculates an average of the current to get the zero value.
function determineADCzero(){
  var averageVoltage = 0;
  for (var i=0; i<5000; i++) {
    averageVoltage += a0_4v.adcRead();
  }
  averageVoltage /= 5000;
  return ~~averageVoltage;
}
