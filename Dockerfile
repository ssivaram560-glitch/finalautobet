FROM node:18-slim

# Puppeteer-க்கு தேவையான Chrome மற்றும் இதர லைப்ரரிகளை இன்ஸ்டால் பண்ணுகிறது
RUN apt-get update && apt-get install -y \
    wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# உன்னுடைய மெயின் ஃபைல் பேரை இங்க போடணும் (உதாரணத்திற்கு node main.js)
CMD ["node", "main.js"]
