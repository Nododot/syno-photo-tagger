const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { ExifTool } = require('exiftool-vendored');

// Charger la configuration
const config = require('./config.json');
const SOURCE_DIR = config.sourceDir;
const LLM_CONFIG = config.llm;

// Initialiser ExifTool
const exifTool = new ExifTool({ taskTimeout: 30000 });

async function generateThumbnail(imagePath, maxSizeKB = 100) {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
    }

    const tempThumbnailPath = path.join(tempDir, `thumb_${path.basename(imagePath)}`);
    const maxSizeBytes = maxSizeKB * 1024; // Convertir 100 Ko en octets

    try {
        // Redimensionner l'image pour réduire sa taille
        await sharp(imagePath)
            .resize(800) // Largeur maximale (hauteur ajustée automatiquement)
            .jpeg({ quality: 80 }) // Qualité JPEG (ajustez si nécessaire)
            .toFile(tempThumbnailPath);

        // Vérifier la taille du fichier généré
        let stats = fs.statSync(tempThumbnailPath);
        let quality = 80;

        // Réduire la qualité jusqu'à ce que la taille soit ≤ 100 Ko
        while (stats.size > maxSizeBytes && quality > 10) {
            quality -= 5;
            await sharp(imagePath)
                .resize(800)
                .jpeg({ quality })
                .toFile(tempThumbnailPath);
            stats = fs.statSync(tempThumbnailPath);
        }

        return tempThumbnailPath;
    } catch (error) {
        console.error(`Erreur lors de la génération de la vignette pour ${imagePath}:`, error.message);
        return null;
    }
}

async function getTagsFromLLM(imagePath) {
    try {
        const thumbnailPath = await generateThumbnail(imagePath, 100);
        if (!thumbnailPath) {
            throw new Error("Impossible de générer la vignette.");
        }

        const base64Image = fs.readFileSync(thumbnailPath, 'base64');

        //const base64Image = fs.readFileSync(imagePath, 'base64');
        let tags = [];

        if (LLM_CONFIG.provider === 'ollama') {
            // Appel à Ollama (local)
            const response = await axios.post(
                LLM_CONFIG.ollamaUrl,
                {
                    model: LLM_CONFIG.model,
                    prompt: `Génère 5 mots-clés en français pour décrire cette photo. Réponds uniquement avec une liste de mots-clés séparés par des virgules, sans texte supplémentaire. [image:${base64Image}]`,
                    stream: false
                },
                { headers: { 'Content-Type': 'application/json' } }
            );
            tags = response.data.response.split(',').map(tag => tag.trim());
        } else {
            // Appel à OpenAI ou Mistral (cloud)
            const apiUrl = LLM_CONFIG.provider === 'openai'
                ? 'https://api.openai.com/v1/chat/completions'
                : 'https://api.mistral.ai/v1/chat/completions';

            const request = {
                model: LLM_CONFIG.model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Génère 5 mots-clés en français pour décrire cette photo. Réponds uniquement avec une liste de mots-clés séparés par des virgules, sans texte supplémentaire.' },
                            { type: 'image_url', image_url: `data:image/jpeg;base64,${base64Image}` }
                        ]
                    }
                ]
            };

            //console.debug(`Exécution de la requête: ${JSON.stringify(request)}`);

            const response = await axios.post(
                apiUrl,
                request,
                {
                    headers: {
                        'Authorization': `Bearer ${LLM_CONFIG.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            tags = response.data.choices[0].message.content.split(',').map(tag => tag.trim());
        }

        return tags;
    } catch (error) {
        console.error(`Erreur lors de l'appel au LLM pour ${imagePath}:`, error.message);
        return [];
    }
}

async function updateExifTags(imagePath, tags) {
    try {
        await exifTool.write(imagePath, { Keywords: tags.join(', ') }, ['-overwrite_original']);
        console.log(`Tags ajoutés à ${imagePath}: ${tags.join(', ')}`);
    } catch (error) {
        console.error(`Erreur lors de la mise à jour des EXIF pour ${imagePath}:`, error.message);
    }
}

async function scanAndTagPhotos() {
    try {
        const files = [];
        // Lire récursivement le dossier source
        function walkDir(dir) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walkDir(fullPath);
                } else if (entry.isFile() && fullPath.toLowerCase().endsWith('.jpg')) {
                    files.push(fullPath);
                }
            }
        }

        walkDir(SOURCE_DIR);

        // Traiter chaque fichier JPG
        for (const imagePath of files) {
            console.log(`Traitement de ${imagePath}...`);
            try {
                const tags = await exifTool.read(imagePath);
                if (!tags.Keywords) {
                    const newTags = await getTagsFromLLM(imagePath);
                    if (newTags.length > 0) {
                        console.log(`Tags générés: ${newTags}`);
                        await updateExifTags(imagePath, newTags);
                    } else {
                        console.log(`Aucun tag généré.`);
                    }
                } else {
                    console.log(`L'image a déjà des tags: ${tags.Keywords}`);
                }
            } catch (error) {
                console.error(`Erreur lors du traitement de ${imagePath}:`, error.message);
            }
        }
    } catch (error) {
        console.error('Erreur lors du scan du dossier:', error.message);
    } finally {
        await exifTool.end();
    }
}

// Lancer le script
scanAndTagPhotos();
