const { Innertube } = require('youtubei.js');

async function test() {
    try {
        console.log('🔄 Connecting to YouTube...');

        const youtube = await Innertube.create();

        console.log('✅ Connected!');

        const info = await youtube.getBasicInfo('liTfD88dbCo');

        console.log('\n🎵 TITLE:');
        console.log(info.basic_info.title);

        console.log('\n📡 Checking streaming formats...');

        const streamingData = info.streaming_data;

        if (!streamingData) {
            console.log('❌ No streaming data available.');
            return;
        }

        console.log('✅ Streaming data found!');

        console.log('\n🎧 Audio formats:');

        const audioFormats = streamingData.adaptive_formats.filter(
            format => format.has_audio
        );

        console.log('Found ' + audioFormats.length + ' audio formats.');

        audioFormats.forEach((format, index) => {
            console.log(
                (index + 1) +
                '. ' +
                format.mime_type +
                ' | ' +
                format.bitrate +
                ' bps'
            );
        });

    } catch (error) {
        console.log('\n❌ ERROR:');
        console.error(error);
    }
}

test();