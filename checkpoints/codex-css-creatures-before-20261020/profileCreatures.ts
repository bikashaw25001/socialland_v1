export type CreatureId = 'dragon'|'bee'|'fox'|'hare'|'elephant'|'owl'|'seal'|'goat'|'marmot'|'squirrel'|'ankylosaurus'|'carnotaurus'|'oviraptor'|'pachycephalosaurus'|'plesiosaurus'|'pterodactylus'|'spinosaurus'|'stegosaurus'|'trex'|'triceratops'|'eagle'|'flamingo'|'hummingbird'|'kiwi'|'macaw'|'peacock'|'pelican'|'penguin'|'rooster'|'toucan'
export type CreatureBehavior = 'dragon'|'bee'|'hop'|'stomp'|'fly'|'swim'|'waddle'|'strut'|'sneak'|'amble'|'peck'
type Creature = { id: CreatureId; name: string; icon: string; greeting: string; reaction: string; behavior: CreatureBehavior; moves: [string,string,string] }

// Models are bundled locally. The profile downloads only the selected GLB.
export const PROFILE_CREATURES: Creature[] = [
 {id:'dragon',name:'Ashwing Dragon',icon:'🐉',greeting:'A tiny dragon says hello!',reaction:'Rawr! I was practicing my fire breath!',behavior:'dragon',moves:['Flying-loop','Walk-loop','Idle-loop']},
 {id:'bee',name:'Bumble Bee',icon:'🐝',greeting:'Bzzzt! So happy to see you!',reaction:'Buzz off? Just kidding, hello!',behavior:'bee',moves:['attack','walk','idle']},
 {id:'fox',name:'Fox',icon:'🦊',greeting:'A clever little hello from Fox!',reaction:'Caught me! Here is a playful glare.',behavior:'sneak',moves:['walk','attack','idle']},
 {id:'hare',name:'Hare',icon:'🐇',greeting:'Hop hop! Welcome to my burrow!',reaction:'Eep! Boing! Try to catch me!',behavior:'hop',moves:['attack','walk','idle']},
 {id:'elephant',name:'Elephant',icon:'🐘',greeting:'A big, gentle hello!',reaction:'That tickles! Have a gentle trumpet!',behavior:'amble',moves:['attack','walk','idle']},
 {id:'owl',name:'Owl',icon:'🦉',greeting:'Hoo is visiting? You are!',reaction:'Hoo poked me? You did!',behavior:'peck',moves:['attack','walk','idle']},
 {id:'seal',name:'Seal',icon:'🦭',greeting:'A splashy hello from Seal!',reaction:'Arf! A splashy reaction for you!',behavior:'swim',moves:['attack','idle','walk']},
 {id:'goat',name:'Goat',icon:'🐐',greeting:'Hey there, mountain friend!',reaction:'Hey! I was about to nap!',behavior:'amble',moves:['attack','walk','idle']},
 {id:'marmot',name:'Marmot',icon:'🐿️',greeting:'Peekaboo! Glad you stopped by!',reaction:'Peekaboo! You found me again!',behavior:'amble',moves:['attack','idle','walk']},
 {id:'squirrel',name:'Squirrel',icon:'🐿️',greeting:'Welcome! I saved you an acorn!',reaction:'Hey! That was my acorn!',behavior:'sneak',moves:['walk','attack','idle']},
 {id:'ankylosaurus',name:'Ankylosaurus',icon:'🦕',greeting:'Tiny tail club, giant hello!',reaction:'Tail swing! Just a tiny warning!',behavior:'stomp',moves:['attack','walk','idle']},
 {id:'carnotaurus',name:'Carnotaurus',icon:'🦖',greeting:'A friendly dino roar for you!',reaction:'Grr! Only a friendly dino roar!',behavior:'stomp',moves:['attack','walk','idle']},
 {id:'oviraptor',name:'Oviraptor',icon:'🦖',greeting:'Dino-sized welcome!',reaction:'Hey! I was guarding that egg!',behavior:'hop',moves:['attack','walk','idle']},
 {id:'pachycephalosaurus',name:'Pachycephalosaurus',icon:'🦕',greeting:'Bonk! Just saying hello!',reaction:'Bonk! That startled me!',behavior:'stomp',moves:['attack','idle','walk']},
 {id:'plesiosaurus',name:'Plesiosaurus',icon:'🦕',greeting:'A wave from the ancient seas!',reaction:'Splash! You made a wave!',behavior:'swim',moves:['walk','attack','idle']},
 {id:'pterodactylus',name:'Pterodactyl',icon:'🪽',greeting:'Flying in to say hello!',reaction:'Squawk! You startled my wings!',behavior:'fly',moves:['attack','walk','idle']},
 {id:'spinosaurus',name:'Spinosaurus',icon:'🦖',greeting:'A fin-tastic hello!',reaction:'A fin flick for you!',behavior:'stomp',moves:['walk','attack','idle']},
 {id:'stegosaurus',name:'Stegosaurus',icon:'🦕',greeting:'Plates up! Welcome, friend!',reaction:'Plates up! Just playing!',behavior:'stomp',moves:['attack','walk','idle']},
 {id:'trex',name:'T-Rex',icon:'🦖',greeting:'The tiniest mighty roar for you!',reaction:'Raaawr! Tiny arms, big reaction!',behavior:'stomp',moves:['attack','walk','idle']},
 {id:'triceratops',name:'Triceratops',icon:'🦕',greeting:'Three cheers for your visit!',reaction:'Charge! Just kidding, hello!',behavior:'stomp',moves:['walk','attack','idle']},
 {id:'eagle',name:'Eagle',icon:'🦅',greeting:'A soaring hello!',reaction:'Wings up! You surprised me!',behavior:'fly',moves:['attack','walk','idle']},
 {id:'flamingo',name:'Flamingo',icon:'🦩',greeting:'One-legged welcome dance!',reaction:'Oops, nearly lost my balance!',behavior:'strut',moves:['walk','attack','idle']},
 {id:'hummingbird',name:'Hummingbird',icon:'🐦',greeting:'A quick little hello!',reaction:'Whoa! That was a fast tap!',behavior:'fly',moves:['attack','walk','idle']},
 {id:'kiwi',name:'Kiwi Bird',icon:'🐤',greeting:'A shy hello from Kiwi!',reaction:'Oh! You found shy little Kiwi!',behavior:'peck',moves:['walk','attack','idle']},
 {id:'macaw',name:'Macaw',icon:'🦜',greeting:'Hello, gorgeous human!',reaction:'Squawk! Say that again!',behavior:'fly',moves:['attack','walk','idle']},
 {id:'peacock',name:'Peacock',icon:'🦚',greeting:'Ta-da! Welcome to my profile!',reaction:'A dramatic pose just for you!',behavior:'strut',moves:['attack','walk','idle']},
 {id:'pelican',name:'Pelican',icon:'🐦',greeting:'A beak-sized hello!',reaction:'Hey! Watch the beak!',behavior:'amble',moves:['walk','attack','idle']},
 {id:'penguin',name:'Penguin',icon:'🐧',greeting:'Waddle you know, a visitor!',reaction:'Waddle you doing?',behavior:'waddle',moves:['walk','attack','idle']},
 {id:'rooster',name:'Rooster',icon:'🐓',greeting:'Cock-a-doodle welcome!',reaction:'Cock-a-doodle! You startled me!',behavior:'strut',moves:['attack','walk','idle']},
 {id:'toucan',name:'Toucan',icon:'🦜',greeting:'Big beak, bigger hello!',reaction:'Big beak says, boop!',behavior:'peck',moves:['walk','attack','idle']},
]



