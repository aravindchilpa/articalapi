const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const Groq = require('groq-sdk');
const NodeCache = require('node-cache');
const dotenv = require('dotenv');

dotenv.config();
const app = express();
app.use(bodyParser.json());
app.use(cors());

const PORT = process.env.PORT;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // replace with a secret key
const IV_LENGTH = 16; // 16 bytes for AES-256-CBC
const API_URL_BASE = process.env.API;
const ALGO = process.env.ALGORITHM;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 }); // TTL of 1 hour

const encodeImageUrl = (url) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, ENCRYPTION_KEY, iv);
  let encryptedUrl = cipher.update(url, 'utf8', 'base64');
  encryptedUrl += cipher.final('base64');
  return `https://ournewsapi.vercel.app/image-urls?url=${encodeURIComponent(`${iv.toString('hex')}:${encryptedUrl}`)}`;
};

const decodeImageUrl = (encryptedUrl) => {
  const [iv, encrypted] = encryptedUrl.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(iv, 'hex'));
  let decryptedUrl = decipher.update(encrypted, 'base64', 'utf8');
  decryptedUrl += decipher.final('utf8');
  return decodeURIComponent(decryptedUrl);
};

const rewriteUsingGroq = async (text, prompt) => {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: `${prompt} "${text}". Provide as detailed a response as possible.`
        }
      ],
      model: "llama3-8b-8192"
    });
    return chatCompletion.choices[0]?.message?.content.trim() || '';
  } catch (error) {
    console.error('Error rewriting using Groq:', error);
    throw error;
  }
};

const summarizeUsingGroq = async (titles) => {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: `Rewrite the following titles concisely and provide only the rewritten titles with detailed and without introduction, separated by line breaks. Titles: ${titles.join("; ")}`
        }
      ],
      model: "llama-3.1-8b-instant"
    });
    const completionContent = chatCompletion.choices[0]?.message?.content.trim() || '';
    return completionContent.split('\n').map(title => title.trim());
  } catch (error) {
    console.error('Error summarizing using Groq:', error);
    throw error;
  }
};

const fetchNewsData = async () => {
  try {
    const url = `${API_URL_BASE}&cache_bust=${Date.now()}`;
    const response = await axios.get(url, { headers: { 'Cache-Control': 'no-store' } });
    const newsList = response.data.data.news_list;
    const minNewsId = response.data.data.min_news_id;
    const titles = newsList.map(news => news.news_obj.title);
    const rewrittenTitles = await summarizeUsingGroq(titles);
    newsData = newsList.map((news, index) => ({
      index,
      title: rewrittenTitles[index] || news.news_obj.title,
      content: news.news_obj.content,
      imageUrl: encodeImageUrl(news.news_obj.image_url),
      minNewsId,
      hashId: news.news_obj.hash_id,
      sourceUrl: news.news_obj.source_url
    }));
    cache.set('news_data', newsData);
  } catch (error) {
    console.error('Error fetching news data:', error);
    newsData = [];
  }
};

const getNews = (req, res) => {
  try {
    const cachedData = cache.get('news_data');
    if (cachedData) {
      res.json(cachedData);
    } else {
      fetchNewsData().then(() => res.json(newsData));
    }
  } catch (error) {
    console.error('Error sending news data:', error);
    res.status(500).json({ error: 'Failed to send data' });
  }
};

const getMoreNews = async (req, res) => {
  try {
    const minNewsId = req.body.minNewsId;
    if (!minNewsId) return res.status(400).send('minNewsId is required');
    const cacheKey = `news_more_${minNewsId}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) return res.json(cachedData);

    const url = `${API_URL_BASE}&news_offset=${minNewsId}&cache_bust=${Date.now()}`;
    const response = await axios.get(url, { headers: { 'Cache-Control': 'no-store' } });
    const newsList = response.data.data.news_list;
    const newMinNewsId = response.data.data.min_news_id;
    const titles = newsList.map(news => news.news_obj.title);
    const rewrittenTitles = await summarizeUsingGroq(titles);

    const newsMoreData = newsList.map((news, index) => ({
      index,
      title: rewrittenTitles[index] || news.news_obj.title,
      content: news.news_obj.content,
      imageUrl: encodeImageUrl(news.news_obj.image_url),
      minNewsId: newMinNewsId,
      hashId: news.news_obj.hash_id,
      sourceUrl: news.news_obj.source_url
    }));

    cache.set(cacheKey, newsMoreData);
    res.json(newsMoreData);
  } catch (error) {
    console.error('Error fetching more news:', error);
    res.status(500).json({ error: 'Failed to send data' });
  }
};

const summarizeArticle = async (req, res) => {
  try {
    const url = req.body.url;
    if (!url) return res.status(400).send('URL is required');

    const data = { url };
    const options = {
      method: 'POST',
      url: 'https://articalapi.vercel.app/summarize',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data)
    };

    const response = await axios(options);
    const { full_text, title, img_url, summary } = response.data;

    // Check if fullText or Title is empty or null
    if (!full_text || !title) {
      return res.json({
        Title: 'There is no data available',
        fullText: 'There is no data available',
        imageUrl: '',
        summary: 'There is no data available'
      });
    }

    const rewrittenText = await rewriteUsingGroq(full_text, "Rewrite the following text and as big response as possible and as detailed text as possible: ");
    const rewrittenTitle = await rewriteUsingGroq(title, "Rewrite the following title with only one option and single title, Don't give multiple titles and without any explanation and as detailed title as possible: ");

    res.json({
      Title: rewrittenTitle,
      fullText: rewrittenText,
      imageUrl: encodeImageUrl(img_url),
      summary: summary
    });
  } catch (error) {
    console.error('Error summarizing article:', error);
    res.status(500).json({ error: 'Failed to summarize article' });
  }
};

app.get('/image-urls', async (req, res) => {
  try {
    const encodedUrl = req.query.url;
    const url = decodeImageUrl(encodedUrl);
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream'
    });

    res.setHeader('Content-Type', response.headers['content-type']);
    response.data.pipe(res);
  } catch (error) {
    console.error('Error fetching the image:', error);
    res.status(500).send('Error fetching the image');
  }
});

app.get('/news', getNews);
app.post('/news-more', getMoreNews);
app.post('/summarize', summarizeArticle);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
