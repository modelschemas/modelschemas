# Speech Recognition (MiMo‑V2.5-ASR) - OpenAI API Compatibility

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
    "description": "The message list.",
    "children": [
      {
        "name": "User message",
        "type": "object",
        "isBold": false,
        "description": "Messages sent by an end user.",
        "children": [
          {
            "name": "content",
            "type": "array",
            "isBold": true,
            "required": true,
            "description": "The contents of the user message.<br /><blockquote class=\\"schema-blockquote\\">For detailed usage, please refer to <a target=\\"_blank\\" rel=\\"noopener noreferrer\\" href=\\"https://platform.xiaomimimo.com/docs/en-US/usage-guide/Speech-Recognition\\">Speech Recognition</a>.</blockquote>",
            "children": [
              {
                "name": "Array of content parts",
                "type": "array",
                "isBold": false,
                "description": "An array of content parts with a defined type. For speech recognition, only single audio input is supported.",
                "children": [
                  {
                    "name": "Audio content part",
                    "type": "object",
                    "isBold": false,
                    "children": [
                      {
                        "name": "input_audio",
                        "type": "object",
                        "isBold": true,
                        "required": true,
                        "description": "<blockquote class=\\"schema-blockquote\\">When audio is passed via data URL, the <code class=\\"schema-inline-code\\">format</code> field is optional. If only Base64-encoded audio data is provided, the <code class=\\"schema-inline-code\\">format</code> field is required. If both <code class=\\"schema-inline-code\\">MIME_TYPE</code> and <code class=\\"schema-inline-code\\">format</code> are included, their values must match.</blockquote>",
                        "children": [
                          {
                            "name": "data",
                            "type": "string",
                            "isBold": true,
                            "required": true,
                            "description": "Base64 encoded audio in a data URL. Input audio only supports <code class=\\"schema-inline-code\\">mp3</code> and <code class=\\"schema-inline-code\\">wav</code> formats:<br /><ul class=\\"schema-list\\"><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">mp3</code>: valid <code class=\\"schema-inline-code\\">MIME_TYPE</code> values: <code class=\\"schema-inline-code\\">audio/mpeg</code>, <code class=\\"schema-inline-code\\">audio/mp3</code></li><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">wav</code>: valid <code class=\\"schema-inline-code\\">MIME_TYPE</code> value: <code class=\\"schema-inline-code\\">audio/wav</code></li></ul>"
                          },
                          {
                            "name": "format",
                            "type": "string",
                            "isBold": true,
                            "description": "The format for encoding audio data.<br />Available options: <code class=\\"schema-inline-code\\">mp3</code>, <code class=\\"schema-inline-code\\">wav</code>"
                          }
                        ]
                      },
                      {
                        "name": "type",
                        "type": "string",
                        "isBold": true,
                        "required": true,
                        "description": "The type of the content part.<br />Available options: <code class=\\"schema-inline-code\\">input_audio</code>"
                      }
                    ]
                  }
                ]
              }
            ]
          },
          {
            "name": "role",
            "type": "string",
            "isBold": true,
            "required": true,
            "description": "Role of the message author.<br />Available options: <code class=\\"schema-inline-code\\">user</code>"
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
    "description": "Model ID is used to generate the response.<br />Available options: <code class=\\"schema-inline-code\\">mimo-v2.5-asr</code>"
  },
  {
    "name": "asr_options",
    "type": "object",
    "isBold": true,
    "required": false,
    "description": "Custom configuration parameters for automatic speech recognition (ASR).",
    "children": [
      {
        "name": "language",
        "type": "string",
        "isBold": true,
        "required": false,
        "defaultValue": "auto",
        "description": "Specify a single language for audio recognition.<br /><ul class=\\"schema-list\\"><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">auto</code>: Auto‑detect audio language</li><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">zh</code>: Chinese</li><li class=\\"schema-list-item\\"><code class=\\"schema-inline-code\\">en</code>: English</li></ul>Available options: <code class=\\"schema-inline-code\\">auto</code>, <code class=\\"schema-inline-code\\">zh</code>, <code class=\\"schema-inline-code\\">en</code>"
      }
    ]
  },
  {
    "name": "stream",
    "type": "boolean",
    "isBold": true,
    "required": false,
    "defaultValue": "false",
    "description": "If set to <code class=\\"schema-inline-code\\">true</code>, the model response data will be streamed to the client as it is generated using server-sent events."
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
          },
          {
            "name": "audio_tokens",
            "type": "integer",
            "isBold": true,
            "description": "Audio input tokens present in the prompt."
          }
        ]
      },
      {
        "name": "seconds",
        "type": "integer",
        "isBold": true,
        "description": "Audio duration (seconds)."
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
    "description": "A unique identifier for the chat completion.  Each chunk has the same ID."
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
          },
          {
            "name": "audio_tokens",
            "type": "integer",
            "isBold": true,
            "description": "Audio input tokens present in the prompt."
          }
        ]
      },
      {
        "name": "seconds",
        "type": "integer",
        "isBold": true,
        "description": "Audio duration (seconds)."
      }
    ]
  }
]`} />
