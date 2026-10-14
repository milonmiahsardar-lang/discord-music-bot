const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder
} = require('discord.js');

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType
} = require('@discordjs/voice');

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();


// ==================================================
// FIND YT-DLP
// ==================================================

function findYtDlp() {

    const bundledPath = path.resolve(
        path.dirname(require.resolve('yt-dlp-exec')),
        '..',
        'bin',
        'yt-dlp.exe'
    );

    if (fs.existsSync(bundledPath)) {
        return bundledPath;
    }

    const result = spawnSync('where.exe', ['yt-dlp'], {
        encoding: 'utf8',
        windowsHide: true
    });

    if (result.status === 0 && result.stdout.trim()) {
        return result.stdout.trim().split(/\r?\n/)[0];
    }

    return null;
}


const YTDLP_PATH = findYtDlp();


if (!YTDLP_PATH) {

    console.error('❌ Could not find yt-dlp.exe');
    console.error('Install project dependencies with "npm install", or add yt-dlp to PATH.');

    process.exit(1);
}


console.log('yt-dlp:', YTDLP_PATH);


// ==================================================
// DISCORD CLIENT
// ==================================================

const client = new Client({

    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]

});


// ==================================================
// MUSIC QUEUES
// ==================================================

const queues = new Map();


// ==================================================
// SLASH COMMANDS
// ==================================================

const commands = [

    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song')
        .addStringOption(option =>
            option
                .setName('song')
                .setDescription('Song name or YouTube URL')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Show the music queue'),

    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current song'),

    new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pause the music'),

    new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Resume the music'),

    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop music and leave the voice channel')

].map(command => command.toJSON());


// ==================================================
// REGISTER COMMANDS
// ==================================================

const rest = new REST({ version: '10' })
    .setToken(process.env.DISCORD_TOKEN);


// ==================================================
// BOT READY
// ==================================================

client.once('clientReady', async () => {

    console.log('========================================');
    console.log('🎵 BOT IS ONLINE');
    console.log('========================================');

    try {

        await rest.put(
            Routes.applicationGuildCommands(
                client.user.id,
                process.env.GUILD_ID
            ),
            {
                body: commands
            }
        );

        console.log('✅ Commands registered');

    } catch (error) {

        console.error('❌ Command registration error:', error);

    }

});


// ==================================================
// RUN YT-DLP
// ==================================================

function runYtDlp(args) {

    return new Promise((resolve, reject) => {

        const process = spawn(YTDLP_PATH, args, {

            windowsHide: true,

            stdio: [
                'ignore',
                'pipe',
                'pipe'
            ]

        });


        let stdout = '';
        let stderr = '';


        process.stdout.on('data', data => {

            stdout += data.toString();

        });


        process.stderr.on('data', data => {

            stderr += data.toString();

        });


        process.on('error', error => {

            reject(error);

        });


        process.on('close', code => {

            if (code === 0) {

                resolve(stdout.trim());

            } else {

                reject(
                    new Error(
                        stderr ||
                        `yt-dlp exited with code ${code}`
                    )
                );

            }

        });

    });

}


// ==================================================
// SEARCH YOUTUBE
// ==================================================

async function searchYouTube(song) {

    let source;


    if (
        song.startsWith('https://www.youtube.com/') ||
        song.startsWith('https://youtu.be/') ||
        song.startsWith('http://www.youtube.com/')
    ) {

        source = song;

    } else {

        source = `ytsearch1:${song}`;

    }


    console.log('Searching:', source);


    // ------------------------------------------
    // GET VIDEO ID
    // ------------------------------------------

    const videoId = await runYtDlp([

        '--flat-playlist',

        '--print',
        '%(id)s',

        '--no-warnings',

        source

    ]);


    if (!videoId) {

        throw new Error(
            'No YouTube video found.'
        );

    }


    const id = videoId
        .split(/\r?\n/)[0]
        .trim();


    const url =
        `https://www.youtube.com/watch?v=${id}`;


    // ------------------------------------------
    // GET VIDEO TITLE
    // ------------------------------------------

    const title = await runYtDlp([

        '--print',
        '%(title)s',

        '--no-warnings',

        '--no-playlist',

        url

    ]);


    return {

        id: id,

        url: url,

        title: title.trim()

    };

}


// ==================================================
// CREATE MUSIC QUEUE
// ==================================================

function getQueue(guildId) {

    if (!queues.has(guildId)) {

        const player = createAudioPlayer({

            behaviors: {

                noSubscriber:
                    NoSubscriberBehavior.Pause

            }

        });


        const queue = {

            songs: [],

            player: player,

            connection: null,

            currentProcess: null,

            playing: false

        };


        queues.set(
            guildId,
            queue
        );


        // ------------------------------------------
        // SONG FINISHED
        // ------------------------------------------

        player.on(
            AudioPlayerStatus.Idle,
            () => {

                console.log(
                    'Song finished'
                );


                queue.currentProcess = null;

                queue.playing = false;


                playNext(guildId)
                    .catch(error => {

                        console.error(
                            'Next song error:',
                            error
                        );

                    });

            }
        );


        // ------------------------------------------
        // PLAYER ERROR
        // ------------------------------------------

        player.on(
            'error',
            error => {

                console.error(
                    'Audio player error:',
                    error
                );


                queue.currentProcess = null;

                queue.playing = false;


                playNext(guildId)
                    .catch(error => {

                        console.error(
                            'Next song error:',
                            error
                        );

                    });

            }
        );

    }


    return queues.get(guildId);

}


// ==================================================
// PLAY NEXT SONG
// ==================================================

async function playNext(guildId) {

    const queue = queues.get(guildId);


    if (!queue) {
        return;
    }


    if (queue.songs.length === 0) {

        queue.playing = false;

        console.log(
            'Queue is empty'
        );

        return;

    }


    const song =
        queue.songs.shift();


    console.log(
        '========================================'
    );

    console.log(
        '▶️ PLAYING:',
        song.title
    );

    console.log(
        '========================================'
    );


    queue.playing = true;


    try {

        // ------------------------------------------
        // START YT-DLP AUDIO STREAM
        // ------------------------------------------

        const audioProcess = spawn(

            YTDLP_PATH,

            [

                '-f',
                'bestaudio',

                '--no-playlist',

                '--no-warnings',

                '-o',
                '-',

                song.url

            ],

            {

                windowsHide: true,

                stdio: [
                    'ignore',
                    'pipe',
                    'pipe'
                ]

            }

        );


        queue.currentProcess =
            audioProcess;


        // ------------------------------------------
        // YT-DLP LOG
        // ------------------------------------------

        audioProcess.stderr.on(
            'data',
            data => {

                const message =
                    data.toString().trim();


                if (message) {

                    console.log(
                        'yt-dlp:',
                        message
                    );

                }

            }
        );


        // ------------------------------------------
        // YT-DLP PROCESS ERROR
        // ------------------------------------------

        audioProcess.on(
            'error',
            error => {

                console.error(
                    '❌ yt-dlp error:',
                    error
                );


                queue.currentProcess = null;

                queue.playing = false;


                playNext(guildId)
                    .catch(console.error);

            }
        );


        // ------------------------------------------
        // YT-DLP PROCESS CLOSED
        // ------------------------------------------

        audioProcess.on(
            'close',
            code => {

                console.log(
                    'yt-dlp process ended:',
                    code
                );

            }
        );


        // ------------------------------------------
        // CREATE AUDIO RESOURCE
        // ------------------------------------------

        const resource =
            createAudioResource(
                audioProcess.stdout,
                {

                    inputType:
                        StreamType.Arbitrary

                }
            );


        // ------------------------------------------
        // PLAY
        // ------------------------------------------

        queue.player.play(
            resource
        );

    } catch (error) {

        console.error(
            '❌ PLAY ERROR:',
            error
        );


        queue.currentProcess = null;

        queue.playing = false;


        await playNext(guildId);

    }

}


// ==================================================
// INTERACTION HANDLER
// ==================================================

client.on(
    'interactionCreate',
    async interaction => {

        if (
            !interaction.isChatInputCommand()
        ) {

            return;

        }


        try {

            // ==================================================
            // PLAY
            // ==================================================

            if (
                interaction.commandName === 'play'
            ) {

                await interaction.deferReply();


                const songName =
                    interaction.options.getString(
                        'song'
                    );


                const voiceChannel =
                    interaction.member.voice.channel;


                if (!voiceChannel) {

                    await interaction.editReply(
                        '❌ You need to join a voice channel first!'
                    );

                    return;

                }


                console.log(
                    '========================================'
                );

                console.log(
                    'Requested:',
                    songName
                );

                console.log(
                    '========================================'
                );


                const queue =
                    getQueue(
                        interaction.guild.id
                    );


                // ------------------------------------------
                // JOIN VOICE CHANNEL
                // ------------------------------------------

                if (!queue.connection) {

                    queue.connection =
                        joinVoiceChannel({

                            channelId:
                                voiceChannel.id,

                            guildId:
                                interaction.guild.id,

                            adapterCreator:
                                interaction.guild
                                    .voiceAdapterCreator

                        });


                    queue.connection.subscribe(
                        queue.player
                    );


                    console.log(
                        'Joined:',
                        voiceChannel.name
                    );

                }


                console.log(
                    'Searching YouTube...'
                );


                // ------------------------------------------
                // SEARCH SONG
                // ------------------------------------------

                const song =
                    await searchYouTube(
                        songName
                    );


                console.log(
                    'Found:',
                    song.title
                );


                queue.songs.push(song);


                // ------------------------------------------
                // PLAY SONG
                // ------------------------------------------

                if (!queue.playing) {

                    await playNext(
                        interaction.guild.id
                    );


                    await interaction.editReply(
                        `▶️ Now playing: ${song.title}`
                    );

                } else {

                    const position =
                        queue.songs.length;


                    await interaction.editReply(

                        `🎵 Added to queue: ${song.title}\n` +
                        `Position: #${position}`

                    );

                }


                return;

            }


            // ==================================================
            // QUEUE
            // ==================================================

            if (
                interaction.commandName === 'queue'
            ) {

                const queue =
                    queues.get(
                        interaction.guild.id
                    );


                if (
                    !queue ||
                    (
                        !queue.playing &&
                        queue.songs.length === 0
                    )
                ) {

                    await interaction.reply(
                        '🎵 The queue is empty.'
                    );

                    return;

                }


                let message =
                    '🎵 **Music Queue**\n\n';


                if (queue.playing) {

                    message +=
                        '▶️ **Currently playing**\n\n';

                }


                if (queue.songs.length > 0) {

                    queue.songs.forEach(
                        (song, index) => {

                            message +=
                                `${index + 1}. ${song.title}\n`;

                        }
                    );

                } else {

                    message +=
                        'No songs waiting in the queue.';

                }


                await interaction.reply(
                    message
                );


                return;

            }


            // ==================================================
            // SKIP
            // ==================================================

            if (
                interaction.commandName === 'skip'
            ) {

                const queue =
                    queues.get(
                        interaction.guild.id
                    );


                if (
                    !queue ||
                    !queue.playing
                ) {

                    await interaction.reply(
                        '❌ Nothing is currently playing.'
                    );

                    return;

                }


                await interaction.reply(
                    '⏭️ Skipping the current song...'
                );


                if (queue.currentProcess) {

                    queue.currentProcess.kill();

                    queue.currentProcess = null;

                }


                queue.player.stop(true);


                return;

            }


            // ==================================================
            // PAUSE
            // ==================================================

            if (
                interaction.commandName === 'pause'
            ) {

                const queue =
                    queues.get(
                        interaction.guild.id
                    );


                if (
                    !queue ||
                    !queue.playing
                ) {

                    await interaction.reply(
                        '❌ Nothing is currently playing.'
                    );

                    return;

                }


                queue.player.pause();


                await interaction.reply(
                    '⏸️ Music paused.'
                );


                return;

            }


            // ==================================================
            // RESUME
            // ==================================================

            if (
                interaction.commandName === 'resume'
            ) {

                const queue =
                    queues.get(
                        interaction.guild.id
                    );


                if (!queue) {

                    await interaction.reply(
                        '❌ Nothing is paused.'
                    );

                    return;

                }


                queue.player.unpause();


                await interaction.reply(
                    '▶️ Music resumed.'
                );


                return;

            }


            // ==================================================
            // STOP
            // ==================================================

            if (
                interaction.commandName === 'stop'
            ) {

                const queue =
                    queues.get(
                        interaction.guild.id
                    );


                if (!queue) {

                    await interaction.reply(
                        '❌ Nothing is playing.'
                    );

                    return;

                }


                queue.songs = [];


                if (queue.currentProcess) {

                    queue.currentProcess.kill();

                    queue.currentProcess = null;

                }


                queue.player.stop(true);


                if (queue.connection) {

                    queue.connection.destroy();

                    queue.connection = null;

                }


                queues.delete(
                    interaction.guild.id
                );


                await interaction.reply(
                    '⏹️ Music stopped and I left the voice channel.'
                );


                return;

            }


        } catch (error) {

            console.error(
                'INTERACTION ERROR:',
                error
            );


            if (interaction.deferred) {

                await interaction.editReply(
                    '❌ Something went wrong while processing your request.'
                ).catch(() => {});

            } else if (!interaction.replied) {

                await interaction.reply(
                    '❌ Something went wrong.'
                ).catch(() => {});

            }

        }

    }
);


// ==================================================
// LOGIN
// ==================================================

client.login(
    process.env.DISCORD_TOKEN
);