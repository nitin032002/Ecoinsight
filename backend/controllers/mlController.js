import axios from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import cloudinary from "../config/cloudinary.js";
import Waste from "../models/Waste.js";
import User from "../models/User.js";

export const classifyWaste = async (req, res) => {
  // If Cloudinary upload fails we fall back to serving the local upload from `/uploads`.
  // In that case we must NOT delete the local file immediately.
  let shouldDeleteLocalFile = true;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const userId = req.user; // From auth middleware
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    
    const filePath = req.file.path;

    // Step 1: Get ML prediction
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));

    const mlResponse = await axios.post("http://127.0.0.1:5000/predict", formData, {
      headers: formData.getHeaders(),
    });

    const prediction = mlResponse.data.prediction; // e.g., "recyclable", "organic", etc.

    // Step 2: Upload image to Cloudinary (fallback to local if misconfigured)
    let imageUrl;
    try {
      const cloudinaryResult = await cloudinary.uploader.upload(filePath, {
        folder: "eco-insight",
        resource_type: "image",
      });
      imageUrl = cloudinaryResult.secure_url;
    } catch (cloudErr) {
      const msg = cloudErr?.message || String(cloudErr);
      console.error("Cloudinary upload failed; falling back to local upload:", msg);

      imageUrl = `/uploads/${path.basename(filePath)}`;
      shouldDeleteLocalFile = false;
    }

    // Step 3: Normalize waste type (ML returns lowercase with underscores)
    const wasteTypeMap = {
      recyclable: "Recyclable",
      organic: "Organic",
      non_recyclable: "Non-Recyclable",
      hazardous: "Hazardous",
    };
    const normalizedWasteType = wasteTypeMap[prediction] || prediction;

    // Step 4: Save waste record to database
    const waste = new Waste({
      userId,
      wasteType: normalizedWasteType,
      imageUrl,
      description: `AI classified as ${normalizedWasteType}`,
    });
    await waste.save();

    // Step 5: Add 10 eco points to user (both current and total earned)
    await User.findByIdAndUpdate(userId, {
      $inc: { ecoPoints: 10, totalPointsEarned: 10 },
    });

    // Step 6: Get updated user points
    const user = await User.findById(userId);

    // Step 7: Check and unlock achievements
    const { checkAndUnlockAchievements } = await import("./achievementController.js");
    const newAchievements = await checkAndUnlockAchievements(userId);

    // Step 8: Clean up local file
    if (shouldDeleteLocalFile) {
      fs.unlinkSync(filePath);
    }

    // Step 9: Return result with image URL, points, and achievements
    return res.json({
      prediction,
      wasteType: normalizedWasteType,
      imageUrl,
      ecoPoints: user.ecoPoints,
      pointsEarned: 10,
      wasteId: waste._id,
      newAchievements: newAchievements.map(a => ({
        id: a.id,
        title: a.title,
        description: a.description,
        icon: a.icon,
      })),
    });
  } catch (err) {
    console.error("❌ ML Service Error:", err.message);
    
    // Clean up file if it exists
    if (shouldDeleteLocalFile && req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkErr) {
        console.error("Error deleting file:", unlinkErr);
      }
    }

    res.status(500).json({ 
      error: "Failed to process classification",
      details: err.message 
    });
  }
};