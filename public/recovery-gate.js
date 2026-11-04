// A late history response must never replace newer input or another selection.
export class RecoveryGate{
 constructor(readInput){this.readInput=readInput;this.serial=0;}
 invalidate(){this.serial++;}
 async load(fetchRecord){const serial=++this.serial,snapshot=this.readInput();const record=await fetchRecord();return serial===this.serial&&snapshot===this.readInput()?record:null;}
}
