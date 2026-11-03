import chalk from 'chalk';
import { setTimeout as wait } from 'timers/promises';
import { monitor } from './cli.js';
import { spawn } from 'child_process';
import readline from 'readline';
import { send } from './send.js';

// const readline = new ReadLine();
// console.info(process.argv);
let w = true;
let to = process.argv[2];
let _try = 4;

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
};
async function go(argv: string) {
	if(argv == 'exit'){
		console.log(chalk.yellowBright('Goodbye!'));
		return process.exit(1);
	}else if(argv == 'monitor'){
		console.info('go to', chalk.yellow('Monitor'));
		await wait(1_000);
		console.clear();
		// await monitor(process.argv[3]);
		return spawn('pm2', ['monit'], { stdio: 'inherit' });
	}else if(argv == 'send'){
		console.info('go to', chalk.yellow('Send'));
		await wait(1_000);
		return await send(true, false);
	}else throw 'not found';
};
(async () => {

console.log(chalk.green('Welcome to Camming Status\n'));


while(w){
	if(_try <= 0)process.exit(1);

	await wait(1_000);
	await go(to).then(()=>{w = false}).catch(async()=>{
		_try <= 3 && console.info(chalk.red('\nNot found! Please try again'), `(${_try})`);
		console.log(`
		Where are you going?
		
	${chalk.bold.whiteBright('monitor')}: PM2 monitor (pm2 monit)
	${chalk.bold.whiteBright('send')}: Send current status to Discord

	${chalk.redBright('exit')}: exit
		`);
		to = await ask('>> ');
	});
	_try--;
};
// console.log(chalk.yellowBright('Goodbye!'));

})();
