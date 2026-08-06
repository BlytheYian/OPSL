import { AutoProcessor, CLIPVisionModelWithProjection, RawImage } from "@huggingface/transformers";

const MODEL = "Xenova/clip-vit-base-patch32";

let processorPromise: ReturnType<typeof AutoProcessor.from_pretrained> | null = null;
let visionModelPromise: ReturnType<typeof CLIPVisionModelWithProjection.from_pretrained> | null = null;

async function getModel() {
  if (!processorPromise) processorPromise = AutoProcessor.from_pretrained(MODEL);
  if (!visionModelPromise) visionModelPromise = CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: "fp32" });
  const [processor, visionModel] = await Promise.all([processorPromise, visionModelPromise]);
  return { processor, visionModel };
}

export async function embedImageFile(filePath: string): Promise<number[]> {
  const { processor, visionModel } = await getModel();
  const image = await RawImage.read(filePath);
  const inputs = await processor(image);
  const { image_embeds } = await visionModel(inputs);
  return Array.from(image_embeds.data as Float32Array);
}
