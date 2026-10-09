# Speech Synthesis (MiMo-TTS Series) - OpenAI API Compatibility

## Request Address

```bash
https://api.xiaomimimo.com/v1/chat/completions
```

## Request Headers

{/* feishu-style:text-align:left */}
The API supports the following two authentication methods. Please choose one and add it to the request headers:

<Tab>
  <TabItem label={`API Key Authentication`}>

```json
api-key: $MIMO_API_KEY
Content-Type: application/json
```

  </TabItem>
  <TabItem label={`Bearer Authentication`}>

```json
Authorization: Bearer $MIMO_API_KEY
Content-Type: application/json
```

  </TabItem>
</Tab>

## Request body 

<InlineSchemaV2 schema={`[
  {
    "name": "messages",
    "type": "array",
    "isBold": true,
    "required": true,
    "description": "The current conversation message list.",
    "children": [
      {
        "name": "User message",
        "type": "object",
        "isBold": false,
        "description": "Messages sent by an end user, containing prompts or additional context information.<br /><blockquote class=\\"schema-blockquote\\">Note: When generating audio using the <code class=\\"schema-inline-code\\">mimo-v2.5-tts-voicedesign</code> model, this message is required and is used to specify the text describing the voice design.</blockquote>",
        "children": [
          {
            "name": "content",
            "type": "string",
            "isBold": true,
            "required": true,
            "description": "The contents of the user message."
          },
          {
            "name": "role",
            "type": "string",
            "isBold": true,
            "required": true,
            "description": "Role of the message author.<br />Available options: <code class=\\"schema-inline-code\\">user</code>"
          }
        ]
      },
      {
        "name": "Assistant message",
        "type": "object",
        "isBold": false,
        "description": "Messages sent by the model in response to user messages.<br /><blockquote class=\\"schema-blockquote\\">Note: When using the <code class=\\"schema-inline-code\\">mimo-v2.5-tts-voicedesign</code> model and <code class=\\"schema-inline-code\\">optimize_text_preview</code> is <code class=\\"schema-inline-code\\">true</code>, the assistant message is optional; in other cases, it is required.</blockquote>",
        "children": [
          {
            "name": "content",
            "type": "string",
            "isBold": true,
            "required": true,
            "description": "The contents of the assistant message, which is used to specify the target text for audio synthesis."
          },
          {
            "name": "role",
            "type": "string",
            "isBold": true,
            "required": true,
            "description": "Role of the message author.<br />Available options: <code class=\\"schema-inline-code\\">assistant</code>"
          }
        ]
      }
    ]
  },
  {
    "name": "model",
    "type": "string",
    "isBold": true,
    "required": true,
    "description": "Model ID is used to generate the response.<br />Available options: <code class=\\"schema-inline-code\\">mimo-v2.5-tts</code>, <code class=\\"schema-inline-code\\">mimo-v2.5-tts-voicedesign</code>, <code class=\\"schema-inline-code\\">mimo-v2.5-tts-voiceclone</code>"
  },
  {
    "name": "audio",
    "type": "object",
    "isBold": true,
    "required": false,
    "description": "Parameters for audio output. For details, please refer to <a target=\\"_blank\\" rel=\\"noopener noreferrer\\" href=\\"https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis-v2.5\\">Speech Synthesis</a>.<br /><blockquote class=\\"schema-blockquote\\">Note: To generate audio, you must add a message with role set to <code class=\\"schema-inline-code\\">assistant</code>, which needs to specify the text for speech synthesis. Additionally, when using the <code class=\\"schema-inline-code\\">mimo-v2.5-tts-voicedesign</code> model, a message with the role of <code class=\\"schema-inline-code\\">user</code> is required. If <code class=\\"schema-inline-code\\">optimize_text_preview</code> is set to <code class=\\"schema-inline-code\\">true</code>, the <code class=\\"schema-inline-code\\">assistant</code> message can be omitted.</blockquote>",
    "children": [
      {
        "name": "format",
        "type": "string",
        "isBold": true,
        "required": false,
        "defaultValue": "wav",
        "description": "Specifies the output audio format. Default: <code class=\\"schema-inline-code\\">wav</code>, or <code class=\\"schema-inline-code\\">pcm</code> when you set <code class=\\"schema-inline-code\\">stream: true</code>.<br /><blockquote class=\\"schema-blockquote\\">Passing in <code class=\\"schema-inline-code\\">pcm</code> or <code class=\\"schema-inline-code\\">pcm16</code> both indicate specifying the use of the <code class=\\"schema-inline-code\\">pcm16</code> format.</blockquote>Available options: <code class=\\"schema-inline-code\\">wav</code>, <code class=\\"schema-inline-code\\">mp3</code>, <code class=\\"schema-inline-code\\">pcm</code>, <code class=\\"schema-inline-code\\">pcm16</code>"
      },
      {
        "name": "optimize_text_preview",
        "type": "boolean",
        "isBold": true,
        "required": false,
        "defaultValue": "false",
        "description": "Enables intelligent optimization of the target audio broadcast text.<br />When set to <code class=\\"schema-inline-code\\">true</code>, the input target text is intelligently polished; if no target text is provided, a broadcast-adapted target text is automatically generated. The finalized processed text is then fed into the model for speech synthesis.<br /><blockquote class=\\"schema-blockquote\\">Note: When this parameter is set to <code class=\\"schema-inline-code\\">true</code>, the <code class=\\"schema-inline-code\\">assistant</code> role message for specifying speech synthesis content can be omitted.</blockquote><blockquote class=\\"schema-blockquote\\">Currently, only the <code class=\\"schema-inline-code\\">mimo-v2.5-tts-voicedesign</code> model is supported.</blockquote>"
      },
      {
        "name": "voice",
        "type": "string",
        "isBold": true,
        "description": "The voice ID of the built-in voice or the base64 encoding of the audio sample.<br /><ul class=\\"schema-list\\"><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">mimo-v2.5-tts</code>: This field is optional and only supports using built-in voices, with the default value being <code class=\\"schema-inline-code\\">mimo_default</code></li><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">mimo-v2.5-tts-voiceclone</code>: This field is required and only supports passing in the base64 encoding of audio samples, and only supports passing in audio sample files in <code class=\\"schema-inline-code\\">mp3</code> and <code class=\\"schema-inline-code\\">wav</code> formats</li><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">mimo-v2.5-tts-voicedesign</code> does not support this field</li></ul>Available options:<br /><ul class=\\"schema-list\\"><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">mimo-v2.5-tts</code>: <code class=\\"schema-inline-code\\">mimo_default</code>, <code class=\\"schema-inline-code\\">冰糖</code>, <code class=\\"schema-inline-code\\">茉莉</code>, <code class=\\"schema-inline-code\\">苏打</code>, <code class=\\"schema-inline-code\\">白桦</code>, <code class=\\"schema-inline-code\\">Mia</code>, <code class=\\"schema-inline-code\\">Chloe</code>, <code class=\\"schema-inline-code\\">Milo</code>, <code class=\\"schema-inline-code\\">Dean</code></li></ul>"
      }
    ]
  },
  {
    "name": "stream",
    "type": "boolean",
    "isBold": true,
    "required": false,
    "defaultValue": "false",
    "description": "If set to true, the model response data will be streamed to the client as it is generated using server-sent events."
  }
]`} />

## Chat response object (non-streaming output) 

<InlineSchemaV2 schema={`[
  {
    "name": "choices",
    "type": "array",
    "isBold": true,
    "description": "A list of chat completion choices.",
    "children": [
      {
        "name": "finish_reason",
        "type": "string",
        "isBold": true,
        "description": "The reason the model stopped generating tokens:<br /><ul class=\\"schema-list\\"><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">stop</code>: The model reached a natural stop point or a user‑provided stop sequence</li><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">length</code>: Terminated due to exceeding the model's maximum generation length</li><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">content_filter</code>: Content was omitted due to a content filter flag</li></ul>"
      },
      {
        "name": "index",
        "type": "integer",
        "isBold": true,
        "description": "The index of the choice in the list of choices."
      },
      {
        "name": "message",
        "type": "object",
        "isBold": true,
        "description": "A chat completion message generated by the model.",
        "children": [
          {
            "name": "content",
            "type": "string",
            "isBold": true,
            "description": "The contents of the message."
          },
          {
            "name": "role",
            "type": "string",
            "isBold": true,
            "description": "The role of the author of this message."
          },
          {
            "name": "audio",
            "type": "object",
            "isBold": true,
            "description": "If the audio output is requested, this object contains data about the audio response from the model.",
            "children": [
              {
                "name": "id",
                "type": "string",
                "isBold": true,
                "description": "Unique identifier for this audio response."
              },
              {
                "name": "data",
                "type": "string",
                "isBold": true,
                "description": "Base64 encoded audio bytes generated by the model, in the format specified in the request."
              },
              {
                "name": "expires_at",
                "type": [
                  "number",
                  "null"
                ],
                "isBold": true,
                "description": "The Unix timestamp (in seconds) for when this audio response expires. Currently always <code class=\\"schema-inline-code\\">null</code>."
              },
              {
                "name": "transcript",
                "type": [
                  "string",
                  "null"
                ],
                "isBold": true,
                "description": "Transcript of the audio generated by the model. Currently always <code class=\\"schema-inline-code\\">null</code>."
              }
            ]
          },
          {
            "name": "final_text_preview",
            "type": "string",
            "isBold": true,
            "description": "The final audio broadcast text after intelligent optimization and polishing. This field is only returned when the request parameter <code class=\\"schema-inline-code\\">optimize_text_preview</code> is set to <code class=\\"schema-inline-code\\">true</code>."
          }
        ]
      }
    ]
  },
  {
    "name": "created",
    "type": "integer",
    "isBold": true,
    "description": "The Unix timestamp (in seconds) of when the chat completion was created."
  },
  {
    "name": "id",
    "type": "string",
    "isBold": true,
    "description": "A unique identifier for the chat completion."
  },
  {
    "name": "model",
    "type": "string",
    "isBold": true,
    "description": "The model to generate the completion."
  },
  {
    "name": "object",
    "type": "string",
    "isBold": true,
    "description": "The object type, which is always <code class=\\"schema-inline-code\\">chat.completion</code>."
  },
  {
    "name": "usage",
    "type": [
      "object",
      "null"
    ],
    "isBold": true,
    "description": "Usage statistics for the completion request.",
    "children": [
      {
        "name": "completion_tokens",
        "type": "integer",
        "isBold": true,
        "description": "Number of tokens in the generated completion."
      },
      {
        "name": "prompt_tokens",
        "type": "integer",
        "isBold": true,
        "description": "Number of tokens in the prompt."
      },
      {
        "name": "total_tokens",
        "type": "integer",
        "isBold": true,
        "description": "Total number of tokens used in the request (prompt + completion)."
      },
      {
        "name": "completion_tokens_details",
        "type": "object",
        "isBold": true,
        "description": "Breakdown of tokens used in a completion.",
        "children": [
          {
            "name": "reasoning_tokens",
            "type": "integer",
            "isBold": true,
            "description": "Tokens generated by the model for reasoning. Always <code class=\\"schema-inline-code\\">0</code>."
          }
        ]
      },
      {
        "name": "prompt_tokens_details",
        "type": "object",
        "isBold": true,
        "description": "Breakdown of tokens used in the prompt.",
        "children": [
          {
            "name": "cached_tokens",
            "type": "integer",
            "isBold": true,
            "description": "Number of tokens served from cache."
          }
        ]
      }
    ]
  }
]`} />

## Chat response chunk object (streaming output) 
<InlineSchemaV2 schema={`[
  {
    "name": "choices",
    "type": "array",
    "isBold": true,
    "description": "A list of chat completion choices.",
    "children": [
      {
        "name": "delta",
        "type": "object",
        "isBold": true,
        "description": "A chat completion delta generated by streamed model responses.",
        "children": [
          {
            "name": "content",
            "type": "string",
            "isBold": true,
            "description": "The contents of the chunk message."
          },
          {
            "name": "role",
            "type": "string",
            "isBold": true,
            "description": "The role of the author of this message."
          },
          {
            "name": "audio",
            "type": [
              "object",
              "null"
            ],
            "isBold": true,
            "description": "If the audio output modality is requested, this object contains data about the audio response from the model.",
            "children": [
              {
                "name": "id",
                "type": "string",
                "isBold": true,
                "description": "Unique identifier for this audio response."
              },
              {
                "name": "data",
                "type": "string",
                "isBold": true,
                "description": "Base64 encoded audio bytes generated by the model, in the format specified in the request."
              },
              {
                "name": "expires_at",
                "type": [
                  "number",
                  "null"
                ],
                "isBold": true,
                "description": "The Unix timestamp (in seconds) for when this audio response expires. Currently always <code class=\\"schema-inline-code\\">null</code>."
              },
              {
                "name": "transcript",
                "type": [
                  "string",
                  "null"
                ],
                "isBold": true,
                "description": "Transcript of the audio generated by the model. Currently always <code class=\\"schema-inline-code\\">null</code>."
              }
            ]
          },
          {
            "name": "final_text_preview",
            "type": "string",
            "isBold": true,
            "description": "The final audio broadcast text after intelligent optimization and polishing. This field is only returned when the request parameter <code class=\\"schema-inline-code\\">optimize_text_preview</code> is set to <code class=\\"schema-inline-code\\">true</code>."
          }
        ]
      },
      {
        "name": "finish_reason",
        "type": [
          "string",
          "null"
        ],
        "isBold": true,
        "description": "The reason the model stopped generating tokens:<br /><ul class=\\"schema-list\\"><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">stop</code>: The model reached a natural stop point or a user‑provided stop sequence</li><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">length</code>: Terminated due to exceeding the model's maximum generation length</li><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">content_filter</code>: Content was omitted due to a content filter flag</li></ul>"
      },
      {
        "name": "index",
        "type": "integer",
        "isBold": true,
        "description": "The index of the choice in the list of choices."
      }
    ]
  },
  {
    "name": "created",
    "type": "integer",
    "isBold": true,
    "description": "The Unix timestamp (in seconds) of when the chat completion was created. Each chunk has the same timestamp."
  },
  {
    "name": "id",
    "type": "string",
    "isBold": true,
    "description": "A unique identifier for the chat completion. Each chunk has the same ID."
  },
  {
    "name": "model",
    "type": "string",
    "isBold": true,
    "description": "The model to generate the completion."
  },
  {
    "name": "object",
    "type": "string",
    "isBold": true,
    "description": "The object type, which is always <code class=\\"schema-inline-code\\">chat.completion.chunk</code>."
  },
  {
    "name": "usage",
    "type": [
      "object",
      "null"
    ],
    "isBold": true,
    "description": "Usage statistics for the completion request.",
    "children": [
      {
        "name": "completion_tokens",
        "type": "integer",
        "isBold": true,
        "description": "Number of tokens in the generated completion."
      },
      {
        "name": "prompt_tokens",
        "type": "integer",
        "isBold": true,
        "description": "Number of tokens in the prompt."
      },
      {
        "name": "total_tokens",
        "type": "integer",
        "isBold": true,
        "description": "Total number of tokens used in the request (prompt + completion)."
      },
      {
        "name": "completion_tokens_details",
        "type": "object",
        "isBold": true,
        "description": "Breakdown of tokens used in a completion.",
        "children": [
          {
            "name": "reasoning_tokens",
            "type": "integer",
            "isBold": true,
            "description": "Tokens generated by the model for reasoning. Always <code class=\\"schema-inline-code\\">0</code>."
          }
        ]
      },
      {
        "name": "prompt_tokens_details",
        "type": "object",
        "isBold": true,
        "description": "Breakdown of tokens used in the prompt.",
        "children": [
          {
            "name": "cached_tokens",
            "type": "integer",
            "isBold": true,
            "description": "Number of tokens served from cache."
          }
        ]
      }
    ]
  }
]`} />
