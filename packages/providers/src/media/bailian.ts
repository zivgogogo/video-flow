const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
  {
    type: "input",
    field: "baseUrl" as const,
    title: "请求地址",
    value: "https://dashscope.aliyuncs.com",
    props: { placeholder: "https://dashscope.aliyuncs.com" },
  },
] as const;

const version = "1.0.1";
const videoResolutions = ["480P", "720P", "1080P"];

type ReferencedVideoRequest = VideoRequest & {
  referenceOrder?: ({ type: "image" | "video" | "audio"; index: number } | { type: "firstFrame" | "lastFrame" | "text" })[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("百炼响应格式错误");
  return value as Record<string, unknown>;
}

function mediaUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function getBaseUrl(value: unknown) {
  const baseUrl = (typeof value === "string" && value.trim() ? value.trim() : "https://dashscope.aliyuncs.com").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("百炼请求地址必须使用 HTTP 或 HTTPS");
  return baseUrl;
}

function requestSignal(context: ProviderContext, timeout: number) {
  return AbortSignal.any([AbortSignal.timeout(timeout), ...(context.signal ? [context.signal] : [])]);
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function imageSize(request: ImageRequest) {
  const value = request.size?.trim();
  if (value) {
    const match = /^(\d+)[x*](\d+)$/i.exec(value);
    if (!match) throw new Error(`百炼图片尺寸格式无效：${value}`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    const pixels = width * height;
    if (pixels < 512 * 512 || pixels > 2048 * 2048 || width / height > 8 || height / width > 8) {
      throw new Error("百炼图片总像素须在 512×512 至 2048×2048 之间，宽高比须在 1:8 至 8:1 之间");
    }
    return `${width}*${height}`;
  }
  const sizes: Record<string, string> = {
    "1:1": "1024*1024", "4:3": "1152*864", "3:4": "864*1152", "16:9": "1280*720",
    "9:16": "720*1280", "3:2": "1536*1024", "2:3": "1024*1536",
  };
  return sizes[request.ratio ?? ""] ?? "1024*1024";
}

function videoPrompt(request: ReferencedVideoRequest, mode: VideoMode) {
  const isFrames = mode === "startEndRequired" || mode === "endFrameOptional" || mode === "startFrameOptional";
  return request.prompt.replace(/\{\{ref (\d+)\}\}/g, (marker, number: string) => {
    const reference = request.referenceOrder?.[Number(number) - 1];
    if (!reference) throw new Error(`引用标记 ${marker} 缺少素材映射`);
    if (reference.type === "text") return `参考 ${Number(number)}`;
    if (reference.type === "firstFrame" || reference.type === "lastFrame") {
      if (!isFrames || !request[reference.type]) throw new Error(`引用标记 ${marker} 对应的首尾帧未提交`);
      return reference.type === "firstFrame" ? "首帧" : "尾帧";
    }
    if (reference.type !== "image" || !Number.isSafeInteger(reference.index) || reference.index < 0 || !request.images?.[reference.index]) {
      throw new Error(`引用标记 ${marker} 对应的参考图片未提交`);
    }
    if (!Array.isArray(mode) && mode !== "singleImage") throw new Error(`引用标记 ${marker} 对应的素材未提交`);
    if (mode === "singleImage" && request.model === "happyhorse-1.1-i2v") return "首帧";
    return request.model === "happyhorse-1.1-r2v" ? `[Image ${reference.index + 1}]` : `图${reference.index + 1}`;
  });
}

function imageAssets(output: Record<string, unknown>): MediaAsset[] {
  if (!Array.isArray(output.choices)) throw new Error("图片生成成功但未返回图片地址");
  const images = output.choices.flatMap(choice => {
    const message = object(object(choice).message ?? {});
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap(item => {
      const image = object(item).image;
      return typeof image === "string" && image ? [{ mediaType: "image" as const, type: "url" as const, url: image }] : [];
    });
  });
  if (!images.length) throw new Error("图片生成成功但未返回图片地址");
  return images;
}

async function waitForTask(context: ProviderContext, apiKey: string, baseUrl: string, mediaType: "image" | "video", taskId: string, signal: AbortSignal): Promise<MediaAsset[]> {
  while (true) {
    const response = await context.tool.fetch(`${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!response.ok) throw new Error(`查询百炼任务失败：HTTP ${response.status}`);
    const result = object(await response.json());
    const output = object(result.output ?? {});
    const status = output.task_status;
    if (status === "SUCCEEDED") {
      if (mediaType === "video") {
        if (typeof output.video_url !== "string" || !output.video_url) throw new Error("视频生成成功但未返回视频地址");
        return [{ mediaType, type: "url", url: output.video_url }];
      }
      return imageAssets(output);
    }
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      throw Object.assign(new Error(context.tool.errorMessage(output) || `百炼任务失败：${status}`), { code: "MEDIA_TASK_FAILED" });
    }
    if (status !== "PENDING" && status !== "RUNNING") throw new Error("百炼返回了未知的任务状态");
    await wait(signal, mediaType === "image" ? 3000 : 15000);
  }
}

async function submitTask(context: ProviderContext, apiKey: string, baseUrl: string, mediaType: "image" | "video", model: string, path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<MediaAsset[]> {
  const baseUrlHash = String(context.tool.hash(baseUrl));
  // ACT: 收费任务提交前先记录不确定状态；响应丢失时只提示人工核查，不自动重复提交。
  await context.saveTaskData?.({ kind: "submitting", mediaType, model, baseUrlHash });
  const response = await context.tool.fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-DashScope-Async": "enable" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`提交百炼任务失败：HTTP ${response.status}`);
  const output = object(object(await response.json()).output ?? {});
  if (typeof output.task_id !== "string" || !output.task_id) throw new Error("提交百炼任务后未返回任务 ID");
  const taskId = output.task_id;
  await context.saveTaskData?.({ kind: "media", mediaType, model, baseUrlHash, taskId });
  return waitForTask(context, apiKey, baseUrl, mediaType, taskId, signal);
}

export default {
  id: "bailian",
  label: "阿里云百炼",
  icon: "data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjFlbSIgc3R5bGU9ImZsZXg6bm9uZTtsaW5lLWhlaWdodDoxIiB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIxZW0iIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHRpdGxlPkFsaWJhYmE8L3RpdGxlPjxwYXRoIGQ9Ik0yNCAxNC4wMTRjLTIuOCAxLjUxMi01LjYyIDIuODk2LTguNzU5IDMuNTI0LS43LjEzOS0xLjQ3Ni4xMzktMi4xODcuMDQzLS42NzgtLjA4NS0xLjAxNy0uNjgyLS43NzYtMS4zMS4yMy0uNTg1LjUzNi0xLjE4MS45My0xLjY3MS44NTItMS4wNjUgMS44MTQtMi4wMzQgMi42NzgtMy4wODhhMTUuNzUgMTUuNzUgMCAwMDEuNDIyLTIuMDU0Yy4zMDYtLjUxMS4xNjQtMS4xMjktLjM3Mi0xLjM4NC0uODk3LS40MzctMS44NTktLjc0NS0yLjgxLTEuMDc1LS4xMS0uMDQzLS4yNzQuMDc0LS40OTIuMTQ5LjI3My4yNDQuNDcuNDI1Ljc0My42Ny0yLjgyMS40OC01LjQ5IDEuMTYtOC4wOCAyLjA5OC0uMDEyLjA1My0uMDMzLjA5NS0uMDIzLjExNy4zODMuNTg1LjIwOCAxLjAzMi0uMzUgMS4zOTRhMi4zNjUgMi4zNjUgMCAwMC0uNTY4LjUyMmMxLjcwNi41IDMuMjI2LjIxMyA0LjY4LS43MzUtLjA4Ny0uMTI3LS4xNzUtLjI0NC0uMjYyLS4zNzIuNTQ2LjA5Ni44NzQuMzk0LjkxOC44NjIuMDExLjEwNy0uMDU0LjIxMy0uMDg3LjMyLS4wNzctLjA4Ni0uMTc1LS4xNy0uMjQtLjI2Ny0uMDQ1LS4wNjQtLjA1Ni0uMTM4LS4wODgtLjI0NS0xLjcyOCAxLjE1LTMuNTg3IDEuNDM4LTUuNjMyLjg0MiAwIC40MDQtLjAyMi43NDUuMDExIDEuMDc1LjAyMi4yODctLjA5OC40MTUtLjM2LjU2NC0uNTkxLjM2Mi0xLjIwNC43MzUtMS42OTYgMS4yMTQtLjU5LjU4NS0uMzcxIDEuMjk5LjQyNyAxLjU5Ny45MDcuMzQgMS44NTkuMzUgMi44MS4yMzQgMS4xMjYtLjEzOSAyLjIzLS4zMiAzLjQ1Ni0uNDktMS40MzMuNjctMi44NDQgMS4xNC00LjMzIDEuMzMtMS4wNC4xNC0yLjA3OC4yMTQtMy4xMDYtLjA4NC0xLjQ3Ni0uNDE1LTIuMTMzLTEuNTAxLTEuNzUtMi45Ni4zNjEtMS4zNjMgMS4yMzYtMi40NDkgMi4xNzYtMy40NSAzLjEzOS0zLjMzMiA3LjEwOC01LjAyNCAxMS43LTUuMzY1IDEuMDcyLS4wNzQgMi4xNTUuMDY0IDMuMTYuNTExIDEuNDExLjYzOSAyLjAwMiAxLjk5IDEuMzEzIDMuMzU0LS40NDguOTA1LTEuMDcyIDEuNzM1LTEuNjk1IDIuNTU1LS42MTIuODA5LTEuMzAxIDEuNTU0LTEuOTQ2IDIuMzMxLS4xODYuMjM0LS4zNjEuNDgtLjUwMy43NDUtLjI3NC41LS4wODguODMuNDkyLjc3OCAxLjIxMy0uMTE4IDIuNDUtLjIxMyAzLjYyLS41MTEgMS43MTYtLjQzNyAzLjM4OS0xLjA1NCA1LjA4NC0xLjU5Ny4xNzUtLjA0My4zMzktLjEwNy40OTItLjE3eiIgZmlsbD0iI0ZGNjAwMyIgZmlsbC1ydWxlPSJldmVub2RkIj48L3BhdGg+PC9zdmc+",
  version,
  readme: `阿里云百炼（DashScope）图片与视频生成。支持 Qwen Image 3.0、HappyHorse 1.1 和 Wan 3.0。

请填写与模型同地域的 API Key。默认使用北京地域；国际站可将请求地址改为 \`https://dashscope-intl.aliyuncs.com\`，也可填写业务空间专属域名。

[前往百炼控制台](https://bailian.console.aliyun.com/)`,
  rules,
  models: [
    {
      id: "qwen-image-3.0",
      label: "Qwen Image 3.0（文生图 / 最多3张参考图）",
      type: "image",
      mode: ["text", "multiReference"],
      imageSizes: ["1024x1024", "1536x1024", "1024x1536", "2048x2048", "1280x720", "720x1280"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
    },
    {
      id: "qwen-image-3.0-pro",
      label: "Qwen Image 3.0 Pro（文生图 / 最多3张参考图）",
      type: "image",
      mode: ["text", "multiReference"],
      imageSizes: ["1024x1024", "1536x1024", "1024x1536", "2048x2048", "1280x720", "720x1280"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
    },
    {
      id: "happyhorse-1.1-t2v",
      label: "HappyHorse 1.1 文生视频",
      type: "video",
      mode: ["text"],
      audio: true,
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "720P", "1080P"] }],
    },
    {
      id: "happyhorse-1.1-i2v",
      label: "HappyHorse 1.1 首帧生视频",
      type: "video",
      mode: ["singleImage"],
      audio: true,
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "720P", "1080P"] }],
    },
    {
      id: "happyhorse-1.1-r2v",
      label: "HappyHorse 1.1 参考图生视频（最多9张）",
      type: "video",
      mode: [["imageReference:9"]],
      audio: true,
      durationResolutionMap: [{ duration: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480P", "720P", "1080P"] }],
    },
    {
      id: "wan3.0-video",
      label: "Wan 3.0 视频（标准版）",
      type: "video",
      mode: ["text", "endFrameOptional", ["imageReference:9"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480P", "720P", "1080P"] }],
    },
    {
      id: "wan3.0-video-prime",
      label: "Wan 3.0 视频（优速版）",
      type: "video",
      mode: ["text", "endFrameOptional", ["imageReference:9"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480P", "720P", "1080P"] }],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写 API Key");
    if (request.model !== "qwen-image-3.0" && request.model !== "qwen-image-3.0-pro") throw new Error("所选百炼图片模型不存在");
    if (!request.prompt.trim()) throw new Error("请输入图片提示词");
    if (request.mask) throw new Error("百炼 Qwen Image 暂不支持蒙版局部重绘");
    const images = request.images ?? [];
    if (images.length > 3) throw new Error("百炼 Qwen Image 3.0 最多支持 3 张参考图");
    const n = request.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > 6) throw new Error("百炼图片生成数量须为 1 至 6 的整数");
    const baseUrl = getBaseUrl(this.config.baseUrl);
    const signal = requestSignal(this, 10 * 60_000);
    // ACT: Qwen Image 3.0 使用同步多模态接口；响应丢失时没有任务 ID，不能自动重提收费请求。
    await this.saveTaskData?.({ kind: "submitting", mediaType: "image", model: request.model, baseUrlHash: String(this.tool.hash(baseUrl)) });
    const response = await this.tool.fetch(`${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: request.model,
        input: {
          messages: [{
            role: "user",
            content: [...images.map(image => ({ image: mediaUrl(image) })), { text: request.prompt }],
          }],
        },
        parameters: {
          size: imageSize(request), n, watermark: false,
          prompt_extend: true, prompt_extend_mode: "direct", enable_thinking: true,
        },
      }),
      signal,
    });
    if (!response.ok) throw new Error(`提交百炼图片生成失败：HTTP ${response.status}`);
    const result = object(await response.json());
    if (result.code) throw new Error(this.tool.errorMessage(result) || "百炼图片生成失败");
    return imageAssets(object(result.output ?? {}));
  },
  async generateVideo(request: ReferencedVideoRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写 API Key");
    const supportedModels = ["happyhorse-1.1-t2v", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v", "wan3.0-video", "wan3.0-video-prime"];
    if (!supportedModels.includes(request.model)) throw new Error("所选百炼视频模型不存在");
    if (request.videos?.length || request.audios?.length) throw new Error("当前百炼视频适配暂未开放参考视频或音频输入");
    const isWan = request.model.startsWith("wan3.0-");
    const mode: VideoMode = request.mode ?? (request.firstFrame || request.lastFrame ? "endFrameOptional"
      : request.images?.length ? request.model === "happyhorse-1.1-i2v" ? "singleImage" : ["imageReference:9"] : "text");
    if (request.model === "happyhorse-1.1-t2v" && mode !== "text") throw new Error("HappyHorse 文生视频不支持参考素材");
    if (request.model === "happyhorse-1.1-i2v" && mode !== "singleImage") throw new Error("HappyHorse 首帧生视频需要 1 张首帧图片");
    if (request.model === "happyhorse-1.1-r2v" && !Array.isArray(mode)) throw new Error("HappyHorse 参考生视频需要参考图片");
    const isFrames = mode === "startEndRequired" || mode === "endFrameOptional" || mode === "startFrameOptional";
    const images = request.images ?? [];
    const media: { type: string; url: string }[] = [];
    if (isFrames) {
      if (!isWan) throw new Error("当前模型不支持首尾帧模式");
      if (mode === "startEndRequired" && (!request.firstFrame || !request.lastFrame)) throw new Error("首尾帧模式需要 2 张图片");
      if (mode === "endFrameOptional" && !request.firstFrame) throw new Error("首帧模式需要首帧图片");
      if (mode === "startFrameOptional" && !request.lastFrame) throw new Error("尾帧模式需要尾帧图片");
      if (request.firstFrame) media.push({ type: "first_frame", url: mediaUrl(request.firstFrame) });
      if (request.lastFrame) media.push({ type: "last_frame", url: mediaUrl(request.lastFrame) });
    } else if (mode === "singleImage" && request.model === "happyhorse-1.1-i2v") {
      if (images.length !== 1) throw new Error("HappyHorse 首帧生视频需要且只需要 1 张首帧图片");
      media.push({ type: "first_frame", url: mediaUrl(images[0]!) });
    } else if (Array.isArray(mode) || mode === "singleImage") {
      if (!images.length || images.length > 9) throw new Error("参考图生视频支持 1 至 9 张参考图片");
      images.forEach(image => media.push({ type: "reference_image", url: mediaUrl(image) }));
    } else if (mode !== "text") {
      throw new Error("当前百炼视频生成模式无效");
    }
    if (mode === "text" && (images.length || request.firstFrame || request.lastFrame)) throw new Error("文生视频模式不能携带参考素材");
    const duration = request.duration ?? 5;
    const minDuration = isWan ? 2 : 3;
    const maxDuration = isWan ? 30 : 15;
    if (!Number.isInteger(duration) || duration < minDuration || duration > maxDuration) throw new Error(`当前模型视频时长须为 ${minDuration} 至 ${maxDuration} 秒的整数`);
    const resolution = (request.resolution ?? "720P").toUpperCase();
    if (!videoResolutions.includes(resolution)) throw new Error("当前模型仅支持 480P、720P、1080P");
    const baseUrl = getBaseUrl(this.config.baseUrl);
    const signal = requestSignal(this, 30 * 60_000);
    return submitTask(this, apiKey, baseUrl, "video", request.model, "/api/v1/services/aigc/video-generation/video-synthesis", {
      model: request.model,
      input: { prompt: videoPrompt(request, mode), ...(media.length ? { media } : {}) },
      parameters: {
        resolution,
        ratio: request.ratio ?? "16:9",
        duration,
        ...(isWan ? { audio: request.generateAudio ?? true } : {}),
      },
    }, signal);
  },
  async resumeTask(data: ProviderTaskData): Promise<MediaAsset[]> {
    if (data.kind === "submitting") throw new Error("上次提交结果未知，不能自动重新提交，请先在百炼控制台确认任务");
    if (data.kind !== "media" || (data.mediaType !== "image" && data.mediaType !== "video")
      || typeof data.taskId !== "string" || !data.taskId || typeof data.model !== "string" || !data.model) {
      throw new Error("百炼任务恢复数据无效");
    }
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写 API Key");
    const baseUrl = getBaseUrl(this.config.baseUrl);
    if (data.baseUrlHash !== String(this.tool.hash(baseUrl))) throw new Error("百炼任务恢复数据无效或请求地址已变更");
    const signal = requestSignal(this, (data.mediaType === "image" ? 10 : 30) * 60_000);
    return waitForTask(this, apiKey, baseUrl, data.mediaType, data.taskId, signal);
  },
} satisfies ProviderDefinition<typeof rules>;
