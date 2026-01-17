# Bento Grid Background Images

Add your background images to this folder with the following names:

1. **location-bg.jpg** - For the location card (city skyline, map theme)
2. **linkedin-bg.jpg** - For the LinkedIn social card
3. **twitter-bg.jpg** - For the Twitter/X social card
4. **building-bg.jpg** - For the "Currently Building" status card
5. **calendar-bg.jpg** - For the availability/calendar card
6. **deloitte-bg.jpg** - For the company card
7. **project-bg.jpg** - For the project showcase card
8. **shipai-bg.jpg** - For the ShipAI featured project
9. **instigpt-bg.jpg** - For the InstiGPT featured project
10. **email-bg.jpg** - For the email contact card
11. **github-bg.jpg** - For the GitHub card
12. **writing-bg.jpg** - For the Thinking and Execution card

## How to Use

To add a background to any bento card:

1. Place your image in this folder
2. Add the `with-bg` class to the card
3. Add inline style: `style="background-image: url('images/bento-backgrounds/your-image.jpg')"`

Example:
```html
<div class="bento-card location-card with-bg" style="background-image: url('images/bento-backgrounds/location-bg.jpg')">
```

Images will automatically display in black & white with a semi-transparent overlay for text readability.
