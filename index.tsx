/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  GoogleGenAI,
  Modality,
  LiveServerMessage,
  Blob
} from '@google/genai';

const startButton = document.getElementById('start-button');
const statusEl = document.getElementById('status');
const transcriptContainerEl = document.getElementById('transcript-container');

function
decode(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data,
  ctx,
  sampleRate,
  numChannels,
) {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}


function encode(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}


function createBlob(data) {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    // The supported audio MIME type is 'audio/pcm'. Do not use other types.
    mimeType: 'audio/pcm;rate=16000',
  };
}


async function main() {
  startButton.style.display = 'none';
  transcriptContainerEl.style.display = 'block';
  statusEl.textContent = 'Connecting...';

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusEl.textContent = 'Your browser does not support the microphone API.';
    return;
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.API_KEY
  });

  let nextStartTime = 0;
  const outputAudioContext = new((window as any).AudioContext ||
    (window as any).webkitAudioContext)({
    sampleRate: 24000
  });
  // Resume audio context on user gesture
  await outputAudioContext.resume();

  const outputNode = outputAudioContext.createGain();
  outputNode.connect(outputAudioContext.destination);

  const sources = new Set();
  let currentInputTranscription = '';
  let currentOutputTranscription = '';

  const sessionPromise = ai.live.connect({
    model: 'gemini-2.5-flash-native-audio-preview-09-2025',
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
    callbacks: {
      onopen: async () => {
        statusEl.textContent = 'Requesting microphone access...';
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: true
            });
            statusEl.textContent = 'Microphone connected. Speak now.';
            const inputAudioContext = new((window as any).AudioContext ||
              (window as any).webkitAudioContext)({
              sampleRate: 16000
            });
            const source = inputAudioContext.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContext.createScriptProcessor(
              4096,
              1,
              1,
            );

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData =
                audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({
                  media: pcmBlob
                });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContext.destination);
        } catch (err) {
            statusEl.textContent = 'Microphone access denied. Please refresh and try again.';
            console.error(err);
        }
      },
      onmessage: async (message) => {
        if (message.serverContent) {
          if (message.serverContent.inputTranscription) {
            const text = message.serverContent.inputTranscription.text;
            currentInputTranscription += text;
            updateTranscriptionUI(
              currentInputTranscription,
              currentOutputTranscription,
            );
          } else if (message.serverContent.outputTranscription) {
            const text = message.serverContent.outputTranscription.text;
            currentOutputTranscription += text;
            updateTranscriptionUI(
              currentInputTranscription,
              currentOutputTranscription,
            );
          }

          const base64EncodedAudioString =
            message.serverContent?.modelTurn?.parts[0]?.inlineData.data;
          if (base64EncodedAudioString) {
            statusEl.textContent = 'Speaking...';
            nextStartTime = Math.max(
              nextStartTime,
              outputAudioContext.currentTime,
            );
            const audioBuffer = await decodeAudioData(
              decode(base64EncodedAudioString),
              outputAudioContext,
              24000,
              1,
            );
            const source = outputAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(outputNode);
            source.addEventListener('ended', () => {
              sources.delete(source);
              if (sources.size === 0) {
                statusEl.textContent = 'Listening...';
              }
            });

            source.start(nextStartTime);
            nextStartTime = nextStartTime + audioBuffer.duration;
            sources.add(source);
          }

          if (message.serverContent.turnComplete) {
            finalizeTranscriptionTurn(
              currentInputTranscription,
              currentOutputTranscription,
            );
            currentInputTranscription = '';
            currentOutputTranscription = '';
          }
        }
      },
      onerror: (e) => {
        console.error(e);
        statusEl.textContent = 'An error occurred. Please refresh the page.';
      },
      onclose: () => {
        statusEl.textContent = 'Connection closed.';
      },
    },
  });

  sessionPromise.catch(err => {
    console.error("Session promise rejected:", err);
    statusEl.textContent = 'Failed to connect. Please check your API key and network connection.';
  });
}

function updateTranscriptionUI(input, output) {
  let userTurn = document.getElementById('user-turn');
  if (!userTurn && input) {
    userTurn = document.createElement('div');
    userTurn.id = 'user-turn';
    userTurn.className = 'transcript-entry';
    userTurn.innerHTML = '<strong>You:</strong> <span></span>';
    transcriptContainerEl.appendChild(userTurn);
  }
  if (userTurn) {
    (userTurn.querySelector('span') as HTMLElement).textContent = input;
  }


  let modelTurn = document.getElementById('model-turn');
  if (!modelTurn && output) {
      modelTurn = document.createElement('div');
      modelTurn.id = 'model-turn';
      modelTurn.className = 'transcript-entry model';
      modelTurn.innerHTML = '<strong>Model:</strong> <span></span>';
      transcriptContainerEl.appendChild(modelTurn);
  }
  if (modelTurn) {
     (modelTurn.querySelector('span') as HTMLElement).textContent = output;
  }
}

function finalizeTranscriptionTurn(input, output) {
  const userTurn = document.getElementById('user-turn');
  if (userTurn) {
    userTurn.id = ''; // Finalize the turn, remove ID
  }
  const modelTurn = document.getElementById('model-turn');
  if (modelTurn) {
    modelTurn.id = ''; // Finalize the turn, remove ID
  }
  transcriptContainerEl.scrollTop = transcriptContainerEl.scrollHeight;
}

startButton.onclick = main;